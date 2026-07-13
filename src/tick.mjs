#!/usr/bin/env node
// tick.mjs — one reconciliation tick: sense → facts → fold → verify →
// hysteresis → derived plan snapshot.
//
//   node src/tick.mjs                  live tick (read-only GitHub fetch)
//   node src/tick.mjs --offline       re-derive from the stored fact log only
//   node src/tick.mjs --no-hysteresis report raw ripeness (skip the I4 gate)
//   node src/tick.mjs --accept-shrink accept an implausibly shrunken open set
//                                     (only when a mass-close is genuinely real)
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
  return {
    ts: nowTs, tick: tickN,
    counts: { ripe: rows.ripe.length, holding: rows.holding.length,
      parked: rows.parked.length, waiting: rows.waiting.length,
      done: rows.done, external: rows.external, wedges: wedges.length },
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

// ---------------------------------------------------------------------------
export async function runTick({
  offline = OFFLINE, noHysteresis = NO_HYST, acceptShrink = ACCEPT_SHRINK,
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
        fetch: () => gh.fetchOpenSet(repo),
        resolveRefs: (referenced, known) => gh.resolveExternalRefs(repo, referenced, known),
      };
    }
    console.error(`[tick] sensing ${sensor.repo}...`);
    const items = sensor.fetch();
    console.error(`[tick] fetched ${items.length} open items`);

    // #4 guard: a degraded/implausibly shrunken sense must fail loudly BEFORE
    // any fact append, descope contradiction, or meta write. The fact log
    // would survive a bogus small sense by design; meta would not.
    const metaPath = resolve(STATE_DIR, 'meta.json');
    const prevCount = existsSync(metaPath)
      ? JSON.parse(readFileSync(metaPath, 'utf8')).length
      : null;
    const plausible = checkSensePlausibility(prevCount, items.length);
    if (!plausible.ok) {
      if (!acceptShrink) {
        throw new DegradedSenseError(
          `${plausible.message} — refusing to overwrite ${metaPath}. ` +
          'If the shrink is real (mass close), re-run with --accept-shrink.');
      }
      console.error(`[tick] WARNING: ${plausible.message} — accepted via --accept-shrink`);
    }

    // first pass to learn referenced numbers, then resolve the external ones
    const first = translate(items, new Map(), nowTs);
    const known = new Set(items.map((i) => i.number));
    const externals = sensor.resolveRefs(first.referenced, known);
    const t = translate(items, externals, nowTs);
    meta = t.meta;
    const novel = store.appendAll(t.facts);
    const descoped = store.appendAll(descopeContradictions(store.all(), meta, nowTs));
    console.error(`[tick] ${novel.length} novel facts, ${descoped.length} descope contradictions`);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(resolve(STATE_DIR, 'meta.json'),
      JSON.stringify([...meta.values()], null, 2));
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
