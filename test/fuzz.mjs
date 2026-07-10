// test/fuzz.mjs — property fuzzer for the engine classifier (regression gate).
//
// Ported from strengthsys design/coordination-model/experiments/e2-liveness/
// fuzz.mjs (the E2 campaign: 0 failures over 40k adversarial sequences),
// retargeted at src/classify.mjs. Generates random and adversarial fact
// sequences and asserts, at EVERY fold prefix:
//
//   (a) totality           — every formed goal in exactly one valid bucket
//   (b) unpark-liveness    — every park a parked goal carries has an unpark
//                            predicate naming a producible fact kind (it can
//                            in principle fire)
//   (c) monotone-done      — a done goal stays done unless an explicit
//                            contradiction arrives; then it re-enters a
//                            bucket, never vanishes
//   (d) no-hot-loop (I3)   — replaying the same tail twice never changes
//                            the partition (idempotence)
//   (e) waiting-acyclicity — no goal is left `waiting` on a dependency
//                            cycle (a cycle cannot clear from a producible
//                            fact within it, so it must be parked instead)
//   (x) crash-freedom      — the fold never throws on adversarial input
//
// Engine deltas vs the E2 original: the generator also targets known goals
// with operator-response / timeout / unpark(reason) facts, to exercise the
// engine's generic unpark firing, multi-park map, and timeout-overdue
// surfacing; the defect matrix is dropped (the engine fold carries no
// defect-injection knobs — the matrix evidence lives in the E2 experiment).
//
// Usage:  node test/fuzz.mjs [numSeeds]     (default 12000 — the CI gate)

import { fold, unparkIsLive } from '../src/classify.mjs';
import { BUCKETS } from '../src/schema.mjs';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const chance = (rng, p) => rng() < p;

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------
const KNOWN_GOALS = ['g0', 'g1', 'g2', 'g3', 'g4'];
const UNKNOWN_GOALS = ['gX', 'gY']; // referenced but never formed
const CAPS = ['net', 'operator', 'opus', 'merge-token'];
const ARTIFACTS = ['spec', 'design', 'impl', 'review', 'pr', 'conditioned'];
const MALFORMED_UNPARKS = [
  ['operator-absence'], // absence-only  -> must be repaired
  ['loop-still-dead'],
  ['still-waiting', 'no-change'],
  [], // empty
  null, // not an array
  'operator-absence', // scalar
  ['banana', 'nonsense-kind'], // unknown, non-producible
];
const LIVE_UNPARKS = [
  ['heartbeat'],
  ['operator-response'],
  ['validity-verdict'],
  ['artifact-produced', 'operator-response'],
  ['artifact-produced:conditioned'], // qualified disjunct (engine extension)
  ['timeout'],
];

// Adversarial profiles bias the injection mix so every hazard gets covered.
const PROFILES = ['uniform', 'cycle-heavy', 'malformed-park', 'contradiction-storm', 'cap-flip', 'dup-heavy'];

export function genSequence(seed) {
  const rng = mulberry32(seed);
  const profile = pick(rng, PROFILES);
  const n = 6 + Math.floor(rng() * 34); // 6..39 facts
  const facts = [];
  let seq = 0;
  let ts = 0;
  const emitted = [];

  const push = (obj) => {
    // ts mostly increases but sometimes jitters backwards (out-of-order)
    ts += chance(rng, 0.15) ? -Math.floor(rng() * 3) : 1 + Math.floor(rng() * 2);
    const f = { ...obj, ts, seq: seq++ };
    facts.push(f);
    emitted.push(f);
  };

  // seed a few goals up front
  for (const g of KNOWN_GOALS) if (chance(rng, 0.7)) push({ kind: 'goal-formed', goal: g });

  for (let i = 0; i < n; i++) {
    // duplicate a prior fact verbatim (idempotence stressor)
    const dupP = profile === 'dup-heavy' ? 0.4 : 0.1;
    if (emitted.length && chance(rng, dupP)) {
      const prev = pick(rng, emitted);
      facts.push({ ...prev }); // exact content duplicate (same ts/seq)
      continue;
    }

    const g = chance(rng, 0.12) ? pick(rng, UNKNOWN_GOALS) : pick(rng, KNOWN_GOALS);

    // profile-weighted kind selection
    let roll = rng();
    if (profile === 'cycle-heavy' && chance(rng, 0.5)) {
      // declare a dependency that tends to close a cycle among known goals
      const a = pick(rng, KNOWN_GOALS);
      const b = pick(rng, KNOWN_GOALS);
      push({ kind: 'goal-formed', goal: a });
      push({ kind: 'goal-formed', goal: b });
      push({ kind: 'dependency-declared', goal: a, dependsOn: b });
      push({ kind: 'dependency-declared', goal: b, dependsOn: a });
      continue;
    }
    if (profile === 'malformed-park' && chance(rng, 0.5)) {
      push({ kind: 'goal-formed', goal: g });
      push({ kind: 'park', goal: g, reason: 'blocked', unpark: pick(rng, MALFORMED_UNPARKS) });
      continue;
    }
    if (profile === 'contradiction-storm' && chance(rng, 0.5)) {
      const kinds = ['goal-done', 'capability-asserted', 'dependency-declared', 'park', 'artifact-produced', 'ghost-kind'];
      const k = pick(rng, kinds);
      const c = { kind: k };
      if (k === 'goal-done' || k === 'park') c.goal = g;
      if (k === 'park' && chance(rng, 0.5)) c.reason = 'blocked';
      if (k === 'dependency-declared') { c.goal = g; c.dependsOn = pick(rng, KNOWN_GOALS); }
      if (k === 'artifact-produced') { c.goal = g; c.artifact = pick(rng, ARTIFACTS); }
      if (k === 'capability-asserted') c.capability = pick(rng, CAPS);
      push({ kind: 'contradiction', contradicts: c });
      continue;
    }
    if (profile === 'cap-flip' && chance(rng, 0.5)) {
      const c = pick(rng, CAPS);
      push({ kind: chance(rng, 0.5) ? 'capability-asserted' : 'capability-revoked', capability: c });
      continue;
    }

    // uniform mix
    if (roll < 0.14) push({ kind: 'goal-formed', goal: g });
    else if (roll < 0.28) push({ kind: 'dependency-declared', goal: g, dependsOn: pick(rng, [...KNOWN_GOALS, ...UNKNOWN_GOALS]) });
    else if (roll < 0.4) push({ kind: 'attempt', goal: g });
    else if (roll < 0.5) push({ kind: 'artifact-produced', goal: g, artifact: pick(rng, ARTIFACTS) });
    else if (roll < 0.58) push({ kind: 'validity-verdict', goal: g, artifact: pick(rng, ARTIFACTS), verdict: chance(rng, 0.5) ? 'pass' : 'fail', inputHash: 'h' + Math.floor(rng() * 5) });
    else if (roll < 0.66) push({ kind: 'goal-done', goal: g });
    else if (roll < 0.76) push({ kind: 'park', goal: g, reason: pick(rng, ['blocked', 'operator', 'needs-conditioning']), unpark: chance(rng, 0.5) ? pick(rng, MALFORMED_UNPARKS) : pick(rng, LIVE_UNPARKS) });
    else if (roll < 0.8) push({ kind: 'unpark', goal: g, ...(chance(rng, 0.4) ? { reason: pick(rng, ['blocked', 'operator']) } : {}) });
    else if (roll < 0.84) push({ kind: 'budget-exhausted', goal: g });
    else if (roll < 0.88) push({ kind: 'heartbeat', source: chance(rng, 0.5) ? g : 'loop' });
    // ref sometimes targets a known goal — exercises generic unpark firing
    else if (roll < 0.92) push({ kind: 'operator-response', ref: chance(rng, 0.6) ? g : 'q' + Math.floor(rng() * 3) });
    else if (roll < 0.96) push({ kind: 'timeout', ref: chance(rng, 0.6) ? g : 't' + Math.floor(rng() * 3) });
    else {
      const c = { kind: pick(rng, ['goal-done', 'capability-asserted', 'dependency-declared', 'park']) };
      c.goal = g; c.capability = pick(rng, CAPS); c.dependsOn = pick(rng, KNOWN_GOALS);
      push({ kind: 'contradiction', contradicts: c });
    }
  }
  return { facts, profile };
}

// ---------------------------------------------------------------------------
// Independent oracles (do NOT reuse classifier internals)
// ---------------------------------------------------------------------------
function formedGoalsUpTo(facts) {
  const s = new Set();
  for (const f of facts) if (f.kind === 'goal-formed') s.add(f.goal);
  return s;
}
function hasContradictionOfDone(facts, goal) {
  return facts.some(
    (f) => f.kind === 'contradiction' && f.contradicts && f.contradicts.kind === 'goal-done' && f.contradicts.goal === goal,
  );
}
// The classifier's contract folds over facts in (ts, seq) order after
// content-dedup. Order-dependent oracles MUST replicate that ordering, or
// they disagree with the classifier on out-of-order-ts inputs.
function canonicalOrder(facts) {
  const seen = new Map();
  for (const f of facts) seen.set(JSON.stringify(f, Object.keys(f).sort()), f);
  return [...seen.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
}
// Independent cycle oracle over not-done formed goals.
function cyclicGoals(rawFacts) {
  const facts = canonicalOrder(rawFacts);
  const formed = new Set(), done = new Set();
  const adj = new Map();
  for (const f of facts) {
    if (f.kind === 'goal-formed') formed.add(f.goal);
    if (f.kind === 'goal-done') done.add(f.goal);
    if (f.kind === 'contradiction' && f.contradicts) {
      if (f.contradicts.kind === 'goal-done') done.delete(f.contradicts.goal);
      if (f.contradicts.kind === 'dependency-declared') {
        const e = adj.get(f.contradicts.goal); if (e) e.delete(f.contradicts.dependsOn);
      }
    }
    if (f.kind === 'dependency-declared') {
      if (!adj.has(f.goal)) adj.set(f.goal, new Set());
      adj.get(f.goal).add(f.dependsOn);
    }
  }
  const active = [...formed].filter((g) => !done.has(g));
  const activeSet = new Set(active);
  const state = new Map(); // 0 white 1 grey 2 black
  const inCycle = new Set();
  const stack = [];
  const dfs = (u) => {
    state.set(u, 1); stack.push(u);
    for (const v of adj.get(u) || []) {
      if (!activeSet.has(v)) continue;
      if (state.get(v) === 1) {
        // back edge: cycle is only the stack suffix from v to the top
        const idx = stack.lastIndexOf(v);
        for (let j = idx; j < stack.length; j++) inCycle.add(stack[j]);
        continue;
      }
      if ((state.get(v) || 0) === 0) dfs(v);
    }
    stack.pop(); state.set(u, 2);
  };
  for (const g of active) if ((state.get(g) || 0) === 0) dfs(g);
  return inCycle;
}
function partitionKey(p) {
  const rows = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([g, c]) => {
    const parks = (c.parks ?? [])
      .map((pk) => `${pk.reason}~${[...pk.unpark.anyOf].sort().join('|')}~${pk.overdue ?? ''}`)
      .sort()
      .join('&');
    return `${g}:${c.bucket}:${c.reason || ''}:${parks}`;
  });
  return rows.join(';;');
}

// ---------------------------------------------------------------------------
// Property checks — return null on pass, or a violation string
// ---------------------------------------------------------------------------
function checkPrefix(facts) {
  let p;
  try {
    p = fold(facts);
  } catch (e) {
    return `(x) crash: ${e.message}`;
  }
  const formed = formedGoalsUpTo(facts);

  // (a) totality
  if (p.size !== formed.size) return `(a) totality: ${formed.size} formed goals but ${p.size} classified`;
  for (const g of formed) {
    if (!p.has(g)) return `(a) totality: formed goal ${g} missing from partition`;
    if (!BUCKETS.includes(p.get(g).bucket)) return `(a) totality: goal ${g} invalid bucket ${p.get(g).bucket}`;
  }

  // (b) unpark-liveness — EVERY park the goal carries (engine multi-park)
  for (const [g, c] of p) {
    if (c.bucket === 'parked') {
      if (!c.unpark || !unparkIsLive(c.unpark)) {
        return `(b) unpark-liveness: parked goal ${g} (reason=${c.reason}) has dead unpark predicate ${JSON.stringify(c.unpark)}`;
      }
      for (const pk of c.parks) {
        if (!unparkIsLive(pk.unpark)) {
          return `(b) unpark-liveness: parked goal ${g} park '${pk.reason}' has dead unpark predicate ${JSON.stringify(pk.unpark)}`;
        }
      }
    }
  }

  // (e) waiting-acyclicity
  const cyc = cyclicGoals(facts);
  for (const [g, c] of p) {
    if (c.bucket === 'waiting' && cyc.has(g)) {
      return `(e) waiting-acyclicity: goal ${g} left waiting on a dependency cycle`;
    }
  }
  return null;
}

export function runSequence(facts) {
  // per-prefix properties (a,b,e,x)
  const prefixes = [];
  for (let i = 1; i <= facts.length; i++) {
    const prefix = facts.slice(0, i);
    const v = checkPrefix(prefix);
    if (v) return { prop: v, at: i };
    try {
      prefixes.push(fold(prefix));
    } catch (e) {
      return { prop: `(x) crash: ${e.message}`, at: i };
    }
  }

  // (c) monotone-done across consecutive prefixes
  for (let i = 1; i < prefixes.length; i++) {
    const prev = prefixes[i - 1], cur = prefixes[i];
    for (const [g, c] of prev) {
      if (c.bucket !== 'done') continue;
      if (!cur.has(g)) return { prop: `(c) monotone-done: done goal ${g} vanished from the partition`, at: i + 1 };
      if (cur.get(g).bucket !== 'done') {
        // flip is allowed ONLY if a contradiction of its goal-done exists
        if (!hasContradictionOfDone(facts.slice(0, i + 1), g)) {
          return { prop: `(c) monotone-done: goal ${g} left 'done' with no contradiction`, at: i + 1 };
        }
      }
    }
  }

  // (d) no-hot-loop / idempotence — replay a tail; partition must not change
  const base = fold(facts);
  const baseKey = partitionKey(base);
  const tries = [facts.length, Math.max(1, facts.length - 3), Math.floor(facts.length / 2)];
  for (const k of tries) {
    const tail = facts.slice(facts.length - k); // last k facts, verbatim
    const replayed = fold([...facts, ...tail]);
    if (partitionKey(replayed) !== baseKey) {
      return { prop: `(d) no-hot-loop: replaying tail of ${k} facts changed the partition`, at: facts.length };
    }
  }
  return null;
}

export function runCampaign(numSeeds, stopOnFirst = false) {
  const failures = [];
  const profileCount = {};
  for (let seed = 1; seed <= numSeeds; seed++) {
    const { facts, profile } = genSequence(seed);
    profileCount[profile] = (profileCount[profile] || 0) + 1;
    const r = runSequence(facts);
    if (r) {
      failures.push({ seed, profile, ...r });
      if (stopOnFirst) break;
    }
  }
  return { failures, profileCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const IS_MAIN = process.argv[1] && process.argv[1].endsWith('fuzz.mjs');
if (IS_MAIN) {
  const NUM = parseInt(process.argv[2] || '12000', 10);
  console.log('=== engine classifier fuzzer (E2 port) ===');
  console.log(`Running ${NUM} seeded sequences against src/classify.mjs...\n`);
  const t0 = Date.now();
  const { failures, profileCount } = runCampaign(NUM, false);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`profiles exercised: ${JSON.stringify(profileCount)}`);
  console.log(`sequences run: ${NUM}   time: ${dt}s`);
  console.log(`FAILURES: ${failures.length}`);
  if (failures.length) {
    for (const f of failures.slice(0, 10)) {
      console.log(`  seed=${f.seed} profile=${f.profile} @prefix ${f.at}: ${f.prop}`);
    }
    process.exitCode = 1;
  }
}
