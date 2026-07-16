#!/usr/bin/env node
// tick.mjs — one reconciliation tick: sense → facts → fold → verify →
// hysteresis → derived plan snapshot.
//
//   node src/tick.mjs                  live tick (read-only GitHub fetch)
//   node src/tick.mjs --offline       re-derive from the stored fact log only
//   node src/tick.mjs --no-hysteresis report raw ripeness (skip the I4 gate)
//   node src/tick.mjs --accept-shrink accept an implausibly shrunken open set
//                                     (only when a mass-close is genuinely real)
//   node src/tick.mjs --full          drill every item, ignoring the updated_at
//                                     watermark (#6) — run periodically to catch
//                                     cross-reference-only changes that don't
//                                     bump an item's updated_at
//
// GitHub is never written. The derived plan is the OUTPUT (snapshots/), the
// fact log is the STATE (state/facts.jsonl), and the hysteresis gate memory
// (state/hysteresis.json) is the only other persistence.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FactStore } from './store.mjs';
import { fold, unparkIsLive } from './classify.mjs';
import { translate, descopeContradictions } from './sense/translate.mjs';
import { verifyRipe } from './verify.mjs';
import { stepGate, newGoalState, KNOBS } from './hysteresis.mjs';
import { TIMEOUT_TTL_DAYS, stageOf, GOAL_TYPES } from './templates.mjs';
import { evaluateGates } from './gates.mjs';
import { specCheckFacts, commandCheckFacts } from './sense/checks.mjs';
import { GATES, SENSORS, STATE_DIR, SNAP_DIR, REPO_ROOT, DELIVERY_TEMPLATE } from './config.mjs';
import { DegradedSenseError } from './sense/github.mjs';

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const NO_HYST = args.includes('--no-hysteresis');
const ACCEPT_SHRINK = args.includes('--accept-shrink');
const FULL_SENSE = args.includes('--full');

/**
 * Plausibility check on a fresh sense against the previous one (#4).
 *
 * GitHub search can return a degraded result set without the
 * `incomplete_results` flag; an implausibly shrunken open set silently
 * clobbering `state/meta.json` is exactly the class of failure the
 * append-only fact log exists to prevent, one layer up. The check only
 * activates once the previous sense is big enough (`minPrev`) for shrinkage
 * to be meaningful, and tolerates legitimate closure churn down to
 * `maxShrink` of the previous count.
 */
export function checkSensePlausibility(prevCount, newCount, { minPrev = 5, maxShrink = 0.5 } = {}) {
  if (prevCount == null || prevCount < minPrev) return { ok: true };
  if (newCount >= prevCount * maxShrink) return { ok: true };
  return {
    ok: false,
    message: `sensed open set shrank implausibly (${prevCount} -> ${newCount} open items)`,
  };
}

/** Manufacture timeout facts for parks past their TTL (I3: absence → fact). */
export function manufactureTimeouts(classification, nowTs, ttlDays = TIMEOUT_TTL_DAYS) {
  const out = [];
  const now = Date.parse(nowTs);
  for (const [goal, c] of classification) {
    if (c.bucket !== 'parked') continue;
    for (const p of c.parks) {
      if (!p.since) continue;
      if (!p.unpark.anyOf.some((d) => d.split(':')[0] === 'timeout')) continue;
      const ttl = (ttlDays[p.reason] ?? ttlDays.default) * 86400e3;
      if (now - Date.parse(p.since) >= ttl) {
        out.push({ ts: nowTs, kind: 'timeout', ref: goal,
          key: `timeout:${goal}:${p.reason}:${p.since}` });
      }
    }
  }
  return out;
}

/**
 * Date gates (#11): keep a goal whose earliest-start date is in the future OUT
 * of `ripe`. The gate is a park (reason `date-gate`) that clears automatically
 * — no operator action — once the tick date reaches it, via a manufactured
 * `date-reached` fact fired through the classifier's generic-unpark path.
 *
 * Manufactured here (not in translate/fold) for two reasons: the fold stays
 * pure and time-free, and — mirroring the verifier park — the park is keyed by
 * `bodyHash` and stamped with `nowTs`, so it is re-emitted on every body edit
 * and survives that same tick's `body-observed`. That gives change/removal of
 * the marker a free clear (any body edit fires the park's `body-observed`
 * disjunct, and the current body re-derives the gate), while an unrelated edit
 * does not defeat a still-future gate. Deterministic: the comparison uses the
 * injected tick date, so replaying a tick reproduces its classification.
 */
export function dateGateFacts(classification, meta, nowTs) {
  const out = [];
  const today = nowTs.slice(0, 10);
  for (const [goal, m] of meta) {
    if (!m.earliestStart) continue;
    if (classification.get(goal)?.bucket === 'done') continue;
    if (today < m.earliestStart) {
      out.push({ ts: nowTs, kind: 'park', goal, reason: 'date-gate',
        unpark: ['date-reached', 'body-observed'],
        evidence: [`earliest-start ${m.earliestStart}`],
        key: `date-gate:${goal}:${m.bodyHash}` });
    } else {
      // gate reached — release any standing date-gate park (generic firing)
      out.push({ ts: nowTs, kind: 'date-reached', ref: goal,
        key: `date-reached:${goal}:${m.earliestStart}` });
    }
  }
  return out;
}

/** Run the thin verifier over ripe delivery goals; returns park + dep facts. */
export function verifierFacts(classification, meta, nowTs) {
  const out = [];
  const isDone = (n) => classification.get(n)?.bucket === 'done';
  for (const [goal, c] of classification) {
    if (c.bucket !== 'ripe' || c.goalType !== 'delivery') continue;
    const m = meta.get(goal);
    if (!m) continue; // no body observed this tick — nothing to verify against
    const v = verifyRipe(m.body, isDone);
    m.routeFloor = v.routeFloor;
    if (v.pass) continue;
    for (const dep of v.deps) {
      out.push({ ts: nowTs, kind: 'dependency-declared', goal, dependsOn: dep,
        source: 'verifier', key: `dep:verifier:${goal}:${dep}` });
    }
    out.push({ ts: nowTs, kind: 'park', goal,
      reason: `verifier:${v.gates.map((g) => g.name).join('+')}`,
      unpark: ['body-observed', 'operator-response', 'timeout'],
      evidence: v.gates.flatMap((g) => g.evidence).slice(0, 6),
      key: `verifier-park:${goal}:${m.bodyHash}` });
  }
  return out;
}

/** Advance every goal's hysteresis gate one tick. */
export function applyHysteresis(classification, hystState, tick, knobs = KNOBS) {
  const next = {};
  const decisions = new Map();
  for (const [goal, c] of classification) {
    if (c.goalType === 'external') continue;
    const prev = hystState[goal] ?? newGoalState();
    const raw = c.bucket === 'ripe';
    const { state, dispatch, holding } = stepGate(prev, raw, tick, knobs);
    next[goal] = state;
    decisions.set(goal, { dispatch, holding });
  }
  return { next, decisions };
}

/** Wedge audit: parked/waiting goals whose unpark can never fire. */
export function wedgeAudit(classification) {
  const violations = [];
  for (const [goal, c] of classification) {
    if (c.bucket === 'parked') {
      for (const p of c.parks) {
        if (!unparkIsLive(p.unpark)) {
          violations.push({ goal, reason: p.reason, unpark: p.unpark.anyOf });
        }
      }
    }
    if (c.bucket === 'waiting') {
      const allDone = c.dependencies.every((d) => classification.get(d)?.bucket === 'done');
      if (allDone) violations.push({ goal, reason: 'waiting-on-done', deps: c.dependencies });
    }
  }
  return violations;
}

/**
 * Frontier-starvation readout (#25): the aggregate view the per-goal wedge
 * audit structurally cannot give. The 2026-07-16 enforce experiment stalled
 * the loop globally while every per-goal check passed — each park's unpark
 * was individually producible, so `wedgeAudit` saw liveness, but NOTHING was
 * dispatchable and no remediation could come ripe. When the frontier is empty
 * (ripe = holding = 0 with parked goals present), this readout surfaces the
 * park-reason histogram and the unpark events ranked by how many goals each
 * would touch — "label one issue `shaped`" beats twelve per-goal lines.
 * Pure projection over the classification the tick already computed.
 */
export function starvationReadout(parkedRows) {
  const byReason = new Map();
  const byUnpark = new Map();
  for (const p of parkedRows) {
    for (const pk of p.parks) {
      byReason.set(pk.reason, (byReason.get(pk.reason) ?? 0) + 1);
      for (const u of pk.unpark) {
        if (!byUnpark.has(u)) byUnpark.set(u, new Set());
        byUnpark.get(u).add(p.goal);
      }
    }
  }
  const byCountThen = (key) => (a, b) => b.count - a.count || (a[key] < b[key] ? -1 : 1);
  return {
    reasons: [...byReason]
      .map(([reason, count]) => ({ reason, count }))
      .sort(byCountThen('reason')),
    unparks: [...byUnpark]
      .map(([event, goals]) => ({ event, count: goals.size, goals: [...goals].sort((x, y) => x - y) }))
      .sort(byCountThen('event')),
  };
}

export function buildSnapshot(classification, meta, decisions, wedges, nowTs, tickN) {
  const rows = { ripe: [], holding: [], parked: [], waiting: [], done: 0, external: 0 };
  for (const [goal, c] of classification) {
    if (c.goalType === 'external') { rows.external++; continue; }
    if (c.bucket === 'done') { rows.done++; continue; }
    const m = meta.get(goal);
    const d = decisions?.get(goal);
    // Stage is REPORTING ONLY (#9): the furthest template stage evidenced by
    // this goal's artifacts + bucket. Journeys use their own template; every
    // other goal uses the active (possibly per-repo thin) delivery template.
    const template = c.goalType === 'journey' ? GOAL_TYPES.journey : DELIVERY_TEMPLATE;
    const stage = stageOf(c, c.artifacts ?? [], template);
    const row = { goal, title: c.title || m?.title || '', goalType: c.goalType,
      focus: m?.focus ?? null, routeFloor: m?.routeFloor, stage };
    if (c.bucket === 'ripe') {
      if (d && !d.dispatch) rows.holding.push(row);
      else rows.ripe.push(row);
    } else if (c.bucket === 'parked') {
      rows.parked.push({ ...row, reason: c.reason,
        overdue: c.parks.some((p) => p.overdue),
        parks: c.parks.map((p) => ({ reason: p.reason, unpark: p.unpark.anyOf,
          since: p.since, overdue: p.overdue ?? null })) });
    } else if (c.bucket === 'waiting') {
      rows.waiting.push({ ...row, dependencies: c.dependencies });
    }
  }
  const focusRank = { current: 0, next: 1, null: 2 };
  const byFocus = (a, b) => (focusRank[a.focus] ?? 2) - (focusRank[b.focus] ?? 2) || a.goal - b.goal;
  rows.ripe.sort(byFocus); rows.holding.sort(byFocus);
  rows.parked.sort((a, b) => a.goal - b.goal);
  rows.waiting.sort((a, b) => a.goal - b.goal);
  // #25: an empty frontier with live parked goals is the globally-stuck shape
  // the per-goal wedge audit cannot flag — mark it and attach the readout so
  // downstream consumers (progress skill, next.mjs) can distinguish "no work
  // I can serve" from "nothing is dispatchable at all"
  const starved = rows.ripe.length === 0 && rows.holding.length === 0 && rows.parked.length > 0;
  return {
    ts: nowTs, tick: tickN,
    counts: { ripe: rows.ripe.length, holding: rows.holding.length,
      parked: rows.parked.length, waiting: rows.waiting.length,
      done: rows.done, external: rows.external, wedges: wedges.length },
    starved,
    starvation: starved ? starvationReadout(rows.parked) : null,
    ...rows, wedges,
  };
}

export function renderMarkdown(snap) {
  const L = [`# Engine tick ${snap.tick} — ${snap.ts.slice(0, 10)}`, ''];
  L.push('| bucket | count |', '|---|---|');
  for (const k of ['ripe', 'holding', 'parked', 'waiting', 'done', 'wedges']) {
    L.push(`| ${k} | ${snap.counts[k]} |`);
  }
  L.push('');
  const item = (r) => `- #${r.goal} ${r.title}${r.goalType === 'journey' ? ' _(journey)_' : ''}` +
    `${r.focus ? ` **[${r.focus}]**` : ''}${r.stage ? ` · stage:${r.stage}` : ''}` +
    `${r.routeFloor ? ` · floor:${r.routeFloor}` : ''}`;
  if (snap.starved) {
    L.push('## ⚠ Frontier empty — nothing is dispatchable', '');
    L.push(`All ${snap.counts.parked} live delivery goals are parked` +
      `${snap.counts.waiting ? ` (+${snap.counts.waiting} waiting)` : ''}. ` +
      'The per-goal wedge audit can pass while the loop is globally stuck — ' +
      'this is the aggregate view.', '');
    L.push('Parks by reason:', '');
    for (const r of snap.starvation.reasons) L.push(`- ${r.reason} ×${r.count}`);
    L.push('', 'Events that would open the frontier (goals touched):', '');
    for (const u of snap.starvation.unparks) {
      L.push(`- \`${u.event}\` → ${u.count} goal${u.count === 1 ? '' : 's'} ` +
        `(${u.goals.map((g) => `#${g}`).join(', ')})`);
    }
    L.push('');
  }
  L.push('## Ripe (dispatchable)', '');
  L.push(...(snap.ripe.length ? snap.ripe.map(item) : ['_none_']), '');
  if (snap.holding.length) {
    L.push('## Ripening (held by hysteresis gate)', '', ...snap.holding.map(item), '');
  }
  const overdue = snap.parked.filter((p) => p.overdue);
  if (overdue.length) {
    L.push('## Attention (parks past TTL — operator surfacing)', '');
    for (const p of overdue) {
      L.push(item(p),
        ...p.parks.filter((pk) => pk.overdue)
          .map((pk) => `  - ${pk.reason} since ${pk.since?.slice(0, 10)}`));
    }
    L.push('');
  }
  L.push('## Parked', '');
  for (const p of snap.parked) {
    L.push(item(p));
    for (const pk of p.parks) {
      L.push(`  - ${pk.reason} — unpark: ${pk.unpark.join(' | ')}${pk.overdue ? ' **[overdue]**' : ''}`);
    }
  }
  if (!snap.parked.length) L.push('_none_');
  L.push('', '## Waiting', '');
  for (const w of snap.waiting) L.push(item(w), `  - on: ${w.dependencies.map((d) => `#${d}`).join(', ')}`);
  if (!snap.waiting.length) L.push('_none_');
  if (snap.gates?.wouldPark?.length || snap.gates?.met?.length) {
    L.push('', '## Shadow gates (reporting only — nothing blocked)', '');
    for (const g of snap.gates.wouldPark) L.push(`- #${g.goal} would park on \`${g.gate}\`: ${g.detail}`);
    if (snap.gates.met.length) {
      L.push('', `Met: ${snap.gates.met.map((g) => `#${g.goal}·${g.gate}`).join(', ')}`);
    }
  }
  if (snap.wedges.length) {
    L.push('', '## WEDGE VIOLATIONS', '',
      ...snap.wedges.map((v) => `- #${v.goal}: ${v.reason}`));
  }
  return L.join('\n') + '\n';
}

/** All #N references an item carries (title + body + comments) — persisted per
 *  item in the sense watermarks so a SKIPPED item's external refs keep being
 *  re-resolved every tick (a dep closing must still read as done, #6). */
export function itemRefs(item) {
  const refs = new Set();
  const scan = (text) => {
    for (const m of (text || '').matchAll(/#(\d+)/g)) refs.add(Number(m[1]));
  };
  scan(`${item.title}\n${item.body}`);
  for (const c of item.comments || []) scan(c.body);
  refs.delete(item.number);
  return [...refs].sort((a, b) => a - b);
}

/**
 * The incremental-sensing drill decision (#6): drill an item unless its
 * `updated_at` watermark says nothing changed since the last drill. Anything
 * without a trustworthy watermark — no previous entry, no updatedAt on either
 * side, or an issue that has since vanished from goal meta — drills. Comments,
 * labels, closes, and body edits all bump `updated_at`; the known blind spot
 * (cross-reference events on OTHER items) is covered by a periodic --full tick.
 */
export function shouldDrillItem(head, prevWm, prevMetaNums) {
  const prev = prevWm?.[head.number];
  if (!prev?.updatedAt || !head.updatedAt) return true;
  if (head.updatedAt > prev.updatedAt) return true;
  if (!head.isPR && !prevMetaNums.has(head.number)) return true;
  return false;
}

// ---------------------------------------------------------------------------
export async function runTick({
  offline = OFFLINE, noHysteresis = NO_HYST, acceptShrink = ACCEPT_SHRINK,
  fullSense = FULL_SENSE,
  sense = null, // injectable sensor for tests: { repo, fetch(), resolveRefs(referenced, known) }
} = {}) {
  const nowTs = new Date().toISOString();
  const store = new FactStore(resolve(STATE_DIR, 'facts.jsonl'));
  let meta = new Map();

  if (!offline) {
    let sensor = sense;
    if (!sensor) {
      const gh = await import('./sense/github.mjs');
      const repo = gh.detectRepo();
      sensor = {
        repo,
        fetch: (opts) => gh.fetchOpenSet(repo, opts),
        resolveRefs: (referenced, known) => gh.resolveExternalRefs(repo, referenced, known),
      };
    }
    console.error(`[tick] sensing ${sensor.repo}...`);

    // #6 watermarks: previous per-item { updatedAt, refs }, keyed by number.
    // Read BEFORE fetching so the drill decision can use them; a missing file
    // (or --full) means every item drills — the safe cold-start default.
    const metaPath = resolve(STATE_DIR, 'meta.json');
    const wmPath = resolve(STATE_DIR, 'sense-watermarks.json');
    const prevMetaArr = existsSync(metaPath)
      ? JSON.parse(readFileSync(metaPath, 'utf8'))
      : null;
    const prevMeta = new Map((prevMetaArr ?? []).map((m) => [m.number, m]));
    const prevWm = (!fullSense && existsSync(wmPath))
      ? JSON.parse(readFileSync(wmPath, 'utf8'))
      : {};

    let sensed = sensor.fetch({
      shouldDrill: (head) => shouldDrillItem(head, prevWm, prevMeta),
    });
    if (Array.isArray(sensed)) sensed = { drilled: sensed, skipped: [] }; // legacy sensor shape
    const { drilled, skipped } = sensed;
    console.error(`[tick] fetched ${drilled.length + skipped.length} open items ` +
      `(${drilled.length} drilled, ${skipped.length} unchanged)`);

    // #4 guard: a degraded/implausibly shrunken sense must fail loudly BEFORE
    // any fact append, descope contradiction, or meta write. The fact log
    // would survive a bogus small sense by design; meta would not.
    const prevCount = prevMetaArr ? prevMetaArr.length : null;
    const plausible = checkSensePlausibility(prevCount, drilled.length + skipped.length);
    if (!plausible.ok) {
      if (!acceptShrink) {
        throw new DegradedSenseError(
          `${plausible.message} — refusing to overwrite ${metaPath}. ` +
          'If the shrink is real (mass close), re-run with --accept-shrink.');
      }
      console.error(`[tick] WARNING: ${plausible.message} — accepted via --accept-shrink`);
    }

    // first pass to learn referenced numbers, then resolve the external ones.
    // Skipped items contribute their PREVIOUSLY-sensed refs: their bodies and
    // comments are unchanged (that's what the watermark says), so the stored
    // ref set is still exact — and a referenced dep that closed since last
    // tick must still be re-resolved to read as done.
    const first = translate(drilled, new Map(), nowTs);
    const known = new Set([...drilled, ...skipped].map((i) => i.number));
    const referenced = new Set(first.referenced);
    for (const s of skipped) {
      for (const r of prevWm[s.number]?.refs ?? []) referenced.add(r);
    }
    const externals = sensor.resolveRefs(referenced, known);
    const t = translate(drilled, externals, nowTs);
    meta = t.meta;
    // an unchanged issue keeps its previous meta entry verbatim (body,
    // bodyDeclared, bodyHash, focus, earliestStart are all body/label-derived,
    // and neither changed) — so descope detection, the verifier, and date
    // gates see the same view a full drill would have produced
    for (const s of skipped) {
      if (!s.isPR && prevMeta.has(s.number)) meta.set(s.number, prevMeta.get(s.number));
    }
    const novel = store.appendAll(t.facts);
    const descoped = store.appendAll(descopeContradictions(store.all(), meta, nowTs));
    console.error(`[tick] ${novel.length} novel facts, ${descoped.length} descope contradictions`);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(metaPath, JSON.stringify([...meta.values()], null, 2));
    // persist watermarks for the whole CURRENT open set (drilled entries fresh,
    // skipped entries carried over); items that left the open set fall out
    const wm = {};
    for (const it of drilled) wm[it.number] = { updatedAt: it.updatedAt ?? null, refs: itemRefs(it) };
    for (const s of skipped) wm[s.number] = prevWm[s.number];
    writeFileSync(wmPath, JSON.stringify(wm, null, 2));
  } else if (existsSync(resolve(STATE_DIR, 'meta.json'))) {
    for (const m of JSON.parse(readFileSync(resolve(STATE_DIR, 'meta.json'), 'utf8'))) {
      meta.set(m.number, m);
    }
  }

  // fold 1 → timeouts → fold 2 → verifier → fold 3 (each append is idempotent)
  let classification = fold(store.all());
  const timeouts = store.appendAll(manufactureTimeouts(classification, nowTs));
  if (timeouts.length) classification = fold(store.all());
  // date gates run BEFORE the verifier/gates: a future-dated goal parks, so the
  // ripe-only verifier and sensor gates skip it (no wasted work on work that
  // isn't startable yet).
  const dgFacts = store.appendAll(dateGateFacts(classification, meta, nowTs));
  if (dgFacts.length) classification = fold(store.all());
  const vFacts = store.appendAll(verifierFacts(classification, meta, nowTs));
  if (vFacts.length) classification = fold(store.all());

  // mechanical sensors, then situational gates (shadow/enforce). A gate has a
  // sensor iff SENSORS carries its required artifact; dispatch by sensor kind
  // ('allium' judges body-cited spec files, 'command' judges by exit code).
  for (const gate of GATES) {
    const sensor = SENSORS?.[gate.requires.artifact];
    if (!sensor) continue; // operator-authority gates have no sensor
    const args = { gate, sensor, classification, meta, existingKeys: store.keys,
      repoRoot: REPO_ROOT, nowTs };
    const produced = sensor.kind === 'allium' ? specCheckFacts(args)
      : sensor.kind === 'command' ? commandCheckFacts(args)
      : [];
    const sFacts = store.appendAll(produced);
    if (sFacts.length) console.error(`[tick] ${sFacts.length} ${gate.id} sensor verdict(s)`);
  }
  const gateResult = evaluateGates(GATES, classification, meta, store.all(), nowTs);
  const gParks = store.appendAll(gateResult.parkFacts);
  if (gParks.length) classification = fold(store.all());

  // hysteresis gate (tick counter persists with the gate memory)
  const hystPath = resolve(STATE_DIR, 'hysteresis.json');
  const hyst = existsSync(hystPath)
    ? JSON.parse(readFileSync(hystPath, 'utf8'))
    : { tick: 0, goals: {} };
  const tickN = hyst.tick + 1;
  let decisions = null;
  if (!noHysteresis) {
    const { next, decisions: d } = applyHysteresis(classification, hyst.goals, tickN);
    decisions = d;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(hystPath, JSON.stringify({ tick: tickN, goals: next }, null, 2));
  }

  const wedges = wedgeAudit(classification);
  const snap = buildSnapshot(classification, meta, decisions, wedges, nowTs, tickN);
  snap.gates = {
    met: gateResult.met,
    wouldPark: gateResult.wouldPark.filter((w) => w.mode === 'shadow'),
    enforced: gateResult.wouldPark.filter((w) => w.mode === 'enforce'),
  };
  mkdirSync(SNAP_DIR, { recursive: true });
  const day = nowTs.slice(0, 10);
  writeFileSync(resolve(SNAP_DIR, `${day}.json`), JSON.stringify(snap, null, 2) + '\n');
  writeFileSync(resolve(SNAP_DIR, `${day}.md`), renderMarkdown(snap));
  console.error(`[tick ${tickN}] ripe=${snap.counts.ripe} holding=${snap.counts.holding} ` +
    `parked=${snap.counts.parked} waiting=${snap.counts.waiting} wedges=${snap.counts.wedges}`);
  console.error(`[tick] wrote snapshots/${day}.{json,md}`);
  return snap;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTick().catch((e) => { console.error(e); process.exit(1); });
}
