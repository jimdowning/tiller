// sense/translate.mjs — GitHub state → canonical facts. ALL the lexical/string
// heuristics live here (E5's verdict: sensing is irreducibly imperative; the
// classifier behind this boundary stays pure).
//
// Translation is a STATELESS re-derivation: each tick replays every item's
// event/comment history and emits the same facts with the same event-derived
// timestamps, so the store's content-dedup makes unchanged history a no-op.
// Body-derived facts (task-list membership, Part-of links, body-observed)
// carry logical keys instead, since bodies are mutable state without event
// timestamps.
import { createHash } from 'node:crypto';
import {
  goalTypeOf, OPERATOR_SIGNAL,
  DEP_BLOCK_PATTERNS, DEP_REF, STARTABLE_YES, RESOLVER,
  TASK_LIST_ITEM, PART_OF, FOCUS_LABELS, META_TRACKER_PREFIXES,
  earliestStartOf,
} from '../templates.mjs';
// The ripeness label contract is PER-REPO: config.mjs resolves it from the
// target repo's DELIVERY_TEMPLATE override (thin repos may gate on a single
// `shaped` label), defaulting to the engine's templates.mjs contract.
import { RIPE_REQUIRES } from '../config.mjs';

const bodyHash = (s) => createHash('sha256').update(s || '').digest('hex').slice(0, 12);
const isMeta = (title = '') => META_TRACKER_PREFIXES.some((p) => title.startsWith(p));

const hasOperatorSignal = (labels) =>
  OPERATOR_SIGNAL.labels.some((l) => labels.has(l))
  || OPERATOR_SIGNAL.labelPrefixes.some((p) => [...labels].some((l) => l.startsWith(p)));

const conditioningComplete = (labels) =>
  RIPE_REQUIRES.labels.every((l) => labels.has(l))
  && RIPE_REQUIRES.labelPrefixes.every((p) => [...labels].some((l) => l.startsWith(p)));

const PR_CLOSES = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
const ANY_REF = /#(\d+)/g;

/**
 * @param items    raw items from sense/github.mjs fetchOpenSet (or fixtures)
 * @param externals Map<number,{state,title,closedAt,createdAt}> resolved refs
 * @param nowTs    ISO timestamp for body-observed facts (injectable for tests)
 * @returns {{facts: object[], meta: Map<number, object>, referenced: Set<number>}}
 */
export function translate(items, externals = new Map(), nowTs = new Date().toISOString()) {
  const facts = [];
  const meta = new Map();
  const referenced = new Set();
  const push = (f) => facts.push(f);

  for (const item of items) {
    const n = item.number;
    const labels = new Set();
    const body = item.body || '';

    // collect every #N reference for external resolution (comments + body)
    for (const m of body.matchAll(ANY_REF)) referenced.add(Number(m[1]));
    for (const c of item.comments || []) {
      for (const m of (c.body || '').matchAll(ANY_REF)) referenced.add(Number(m[1]));
    }

    // ---- PRs are not goals: they produce artifacts on the issues they close
    if (item.isPR) {
      const text = `${item.title}\n${body}`;
      const targets = new Set();
      for (const m of text.matchAll(PR_CLOSES)) targets.add(Number(m[3]));
      const merged = (item.events || []).find((e) => e.event === 'merged');
      for (const t of targets) {
        referenced.add(t);
        push({ ts: item.createdAt, kind: 'artifact-produced', goal: t, artifact: `pr#${n}` });
        if (merged) {
          push({ ts: merged.ts, kind: 'artifact-produced', goal: t, artifact: `pr#${n}-merged` });
        }
      }
      continue;
    }

    // ---- meta trackers are bookkeeping, not goals (journeys are NOT meta) --
    if (isMeta(item.title)) continue;

    // ---- formation ---------------------------------------------------------
    for (const l of item.labels || []) labels.add(l); // final state; replayed below
    const goalType = goalTypeOf(labels);
    push({ ts: item.createdAt, kind: 'goal-formed', goal: n, goalType,
      title: item.title, key: `formed:${n}:${goalType}` });

    // ---- replay label events for conditioning + operator-signal transitions
    // (initial labels at creation, then labeled/unlabeled events in order)
    const replay = new Set(item.labels || []);
    // reconstruct creation-time labels by unwinding events backwards
    const labelEvents = (item.events || [])
      .filter((e) => e.event === 'labeled' || e.event === 'unlabeled')
      .sort((a, b) => (a.ts < b.ts ? -1 : 1));
    for (let i = labelEvents.length - 1; i >= 0; i--) {
      const e = labelEvents[i];
      if (e.event === 'labeled') replay.delete(e.label);
      else replay.add(e.label);
    }

    let condDone = conditioningComplete(replay);
    let opSignal = hasOperatorSignal(replay);
    if (goalType === 'delivery' && !condDone) {
      push({ ts: item.createdAt, kind: 'park', goal: n, reason: 'needs-conditioning',
        unpark: ['artifact-produced:conditioned'] });
    }
    if (condDone) {
      push({ ts: item.createdAt, kind: 'artifact-produced', goal: n, artifact: 'conditioned' });
    }
    if (opSignal) {
      push({ ts: item.createdAt, kind: 'park', goal: n, reason: 'operator',
        unpark: ['operator-response', 'timeout'] });
    }
    for (const e of labelEvents) {
      if (e.event === 'labeled') replay.add(e.label); else replay.delete(e.label);
      const nowCond = conditioningComplete(replay);
      if (goalType === 'delivery' && nowCond !== condDone) {
        if (nowCond) {
          push({ ts: e.ts, kind: 'artifact-produced', goal: n, artifact: 'conditioned' });
        } else {
          push({ ts: e.ts, kind: 'contradiction',
            contradicts: { kind: 'artifact-produced', goal: n, artifact: 'conditioned' } });
          push({ ts: e.ts, kind: 'park', goal: n, reason: 'needs-conditioning',
            unpark: ['artifact-produced:conditioned'] });
        }
        condDone = nowCond;
      }
      const nowOp = hasOperatorSignal(replay);
      if (nowOp !== opSignal) {
        if (nowOp) {
          push({ ts: e.ts, kind: 'park', goal: n, reason: 'operator',
            unpark: ['operator-response', 'timeout'] });
        } else {
          // removing the last operator label IS the operator acting
          push({ ts: e.ts, kind: 'operator-response', ref: n });
        }
        opSignal = nowOp;
      }
    }

    // ---- open/closed lifecycle --------------------------------------------
    for (const e of (item.events || [])) {
      if (e.event === 'closed') push({ ts: e.ts, kind: 'goal-done', goal: n });
      if (e.event === 'reopened') {
        push({ ts: e.ts, kind: 'contradiction', contradicts: { kind: 'goal-done', goal: n } });
      }
    }
    if (item.state === 'closed' && !(item.events || []).some((e) => e.event === 'closed')) {
      push({ ts: item.closedAt ?? nowTs, kind: 'goal-done', goal: n });
    }

    // ---- comment-borne signals ---------------------------------------------
    // `operator-response` is emitted ONLY against an outstanding operator park
    // (live-tick finding: routine **FYI** comments are noise, not operator
    // acts — emitting one per FYI unparked goals that were never resolved).
    const commentDeps = new Set();
    let opOutstanding = opSignal;
    for (const c of (item.comments || []).slice().sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
      const text = c.body || '';
      if (/ACTION REQUIRED/.test(text)) {
        push({ ts: c.ts, kind: 'park', goal: n, reason: 'operator',
          unpark: ['operator-response', 'timeout'] });
        opOutstanding = true;
      }
      if (opOutstanding && RESOLVER.test(text) && !/ACTION REQUIRED/.test(text)) {
        push({ ts: c.ts, kind: 'operator-response', ref: n });
        opOutstanding = false;
      }
      if (DEP_BLOCK_PATTERNS.some((r) => r.test(text))) {
        const m = text.match(DEP_REF);
        if (m) {
          const dep = Number(m[1]);
          commentDeps.add(dep);
          referenced.add(dep);
          push({ ts: c.ts, kind: 'dependency-declared', goal: n, dependsOn: dep, source: 'comment' });
        } else {
          // E6's #419 correction: a dependency on UNTRACKED work has no fact
          // to wait on — park with a producible unpark, don't fake a dep edge
          push({ ts: c.ts, kind: 'park', goal: n, reason: 'untracked-dependency',
            unpark: ['dependency-declared', 'operator-response', 'timeout'] });
        }
      }
      if (STARTABLE_YES.test(text)) {
        // a startable:yes verdict is a genuine derisking act: it retires
        // previously sensed comment-borne deps and any untracked-dependency park
        for (const dep of commentDeps) {
          push({ ts: c.ts, kind: 'contradiction',
            contradicts: { kind: 'dependency-declared', goal: n, dependsOn: dep } });
        }
        commentDeps.clear();
        push({ ts: c.ts, kind: 'unpark', goal: n, reason: 'untracked-dependency' });
      }
    }

    // ---- body-borne structure (issues-only journey membership) --------------
    const bodyDeclared = [];
    for (const m of body.matchAll(TASK_LIST_ITEM)) {
      const child = Number(m[2]);
      if (child === n) continue; // self-reference is never a dependency
      referenced.add(child);
      bodyDeclared.push({ goal: n, dependsOn: child });
      push({ ts: item.createdAt, kind: 'dependency-declared', goal: n, dependsOn: child,
        source: 'body', key: `dep:body:${n}:${child}` });
    }
    const partOf = body.match(PART_OF);
    if (partOf) {
      const parent = Number(partOf[1]);
      if (parent !== n) {
        referenced.add(parent);
        bodyDeclared.push({ goal: parent, dependsOn: n });
        push({ ts: item.createdAt, kind: 'dependency-declared', goal: parent, dependsOn: n,
          source: 'body', key: `dep:body:${parent}:${n}` });
      }
    }

    const hash = bodyHash(body);
    push({ ts: nowTs, kind: 'body-observed', goal: n, hash, key: `body:${n}:${hash}` });

    const focus = Object.entries(FOCUS_LABELS).find(([l]) => labels.has(l))?.[1] ?? null;
    // Date gate: the DECLARED earliest-start date (#11). The tick decides
    // whether it currently blocks by comparing against the injected tick date
    // (dateGateFacts) — sensing only records the declaration, so the fold stays
    // pure and time-free.
    const earliestStart = earliestStartOf(body, labels);
    meta.set(n, { number: n, title: item.title, labels: [...labels], goalType,
      focus, body, bodyHash: hash, bodyDeclared, earliestStart });
  }

  // ---- externally referenced items (closed deps must read as done) ---------
  for (const [n, info] of externals) {
    push({ ts: info.createdAt ?? nowTs, kind: 'goal-formed', goal: n,
      goalType: 'external', title: info.title, key: `formed:${n}:external` });
    if (info.state === 'closed') {
      push({ ts: info.closedAt ?? nowTs, kind: 'goal-done', goal: n, key: `done:${n}:external` });
    }
  }

  return { facts, meta, referenced };
}

/**
 * Descope detection: body-sourced dependency edges present in the log but no
 * longer declared in any current body get a contradiction (a task-list line
 * was deleted = the child was descoped from the journey).
 */
export function descopeContradictions(storeFacts, meta, nowTs = new Date().toISOString()) {
  const current = new Set();
  for (const m of meta.values()) {
    for (const d of m.bodyDeclared) current.add(`${d.goal}:${d.dependsOn}`);
  }
  const contradicted = new Set();
  for (const f of storeFacts) {
    if (f.kind === 'contradiction' && f.contradicts?.kind === 'dependency-declared') {
      contradicted.add(`${f.contradicts.goal}:${f.contradicts.dependsOn}`);
    }
  }
  const out = [];
  for (const f of storeFacts) {
    if (f.kind !== 'dependency-declared' || f.source !== 'body') continue;
    const k = `${f.goal}:${f.dependsOn}`;
    // only re-judge edges whose declaring side was observed this tick
    const declaringSide = meta.has(f.goal) || meta.has(f.dependsOn);
    if (!declaringSide || current.has(k) || contradicted.has(k)) continue;
    out.push({ ts: nowTs, kind: 'contradiction',
      contradicts: { kind: 'dependency-declared', goal: f.goal, dependsOn: f.dependsOn },
      key: `descope:${k}:${f.key ?? ''}` });
    contradicted.add(k);
  }
  return out;
}
