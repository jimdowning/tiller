// classify.mjs — the pure, TOTAL classifier over the canonical fact log.
//
// Adapted from e2-liveness/classifier.mjs (the fuzz-validated core: 0 failures
// over 40k adversarial sequences) with the engine extensions:
//   - generic unpark firing: a park clears when a LATER fact whose kind is in
//     the park's unpark.anyOf targets the same goal (explicit `unpark` facts
//     still work; this makes operator-response / timeout / dependency-declared
//     / body-observed fire parks without a separate unpark append)
//   - goalType carried through from goal-formed (journey vs delivery)
//   - artifacts accumulated for stage reporting
//
// Invariants enforced here:
//   I1 — contradictions flip derived predicates, never delete facts
//   I3 — every parked goal's unpark predicate references at least one
//        PRODUCIBLE fact kind (repaired by manufacturing a `timeout` disjunct)
//   totality — every formed goal lands in exactly one bucket
import { PRODUCIBLE_FACT_KINDS, canonicalKey, factTarget } from './schema.mjs';

export const STALL_THRESHOLD = 3;

// An unpark disjunct is a fact kind, optionally qualified by artifact name:
// 'artifact-produced:conditioned' fires only on that artifact; bare
// 'artifact-produced' fires on any.
const disjunctKind = (d) => d.split(':')[0];
export function disjunctFires(disjunct, fact) {
  const [kind, qualifier] = disjunct.split(':');
  if (fact.kind !== kind) return false;
  if (qualifier != null && fact.artifact !== qualifier) return false;
  // a FAILING validity verdict never unparks — only a pass clears a gate
  if (fact.kind === 'validity-verdict' && fact.verdict !== 'pass') return false;
  return true;
}

export function normalizeUnpark(unparkList, fallback = ['timeout']) {
  const declared = Array.isArray(unparkList) ? unparkList.slice() : [];
  const hasProducible = declared.some((k) => PRODUCIBLE_FACT_KINDS.has(disjunctKind(k)));
  if (hasProducible) return { anyOf: declared, manufactured: [] };
  const manufactured = fallback.filter((k) => !declared.includes(k));
  return { anyOf: [...declared, ...manufactured], manufactured };
}

export function unparkIsLive(pred) {
  return pred.anyOf.some((k) => PRODUCIBLE_FACT_KINDS.has(disjunctKind(k)));
}

// --- cycle detection over the active dependency graph (from E2, verbatim) ---
function goalsInCycles(edges, notDone) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map();
  const inCycle = new Set();
  for (const g of notDone) colour.set(g, WHITE);
  for (const start of notDone) {
    if (colour.get(start) !== WHITE) continue;
    const stack = [{ node: start, it: (edges.get(start) || new Set()).values() }];
    const onPath = new Set([start]);
    colour.set(start, GREY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nx = top.it.next();
      if (nx.done) {
        colour.set(top.node, BLACK);
        onPath.delete(top.node);
        stack.pop();
        continue;
      }
      const dep = nx.value;
      if (!notDone.has(dep)) continue;
      if (onPath.has(dep)) {
        // only the path suffix from `dep` is cyclic; feeders stay `waiting`
        let idx = stack.length - 1;
        while (idx >= 0 && stack[idx].node !== dep) idx--;
        for (let j = Math.max(idx, 0); j < stack.length; j++) inCycle.add(stack[j].node);
        continue;
      }
      if (colour.get(dep) === WHITE) {
        colour.set(dep, GREY);
        onPath.add(dep);
        stack.push({ node: dep, it: (edges.get(dep) || new Set()).values() });
      }
    }
  }
  return inCycle;
}

function dedupAndSort(rawFacts) {
  const seen = new Map();
  for (const f of rawFacts) seen.set(canonicalKey(f), f);
  const facts = [...seen.values()];
  facts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.seq ?? 0) - (b.seq ?? 0)));
  return facts;
}

// ---------------------------------------------------------------------------
// The fold: facts -> Map<goal, classification>
// ---------------------------------------------------------------------------
export function fold(rawFacts) {
  const facts = dedupAndSort(rawFacts);
  const goals = new Map();
  const caps = new Set();

  const ensure = (g) => {
    if (!goals.has(g)) {
      goals.set(g, {
        formed: false, goalType: 'delivery', title: '',
        done: false, deps: new Set(), artifacts: new Set(),
        // parks is a Map<reason, {unpark, ts}> — a goal can carry SEVERAL
        // concurrent blockers (unconditioned AND operator-parked); losing one
        // to a single-slot overwrite was a live-tick finding, not a theory
        parks: new Map(), stall: 0,
      });
    }
    return goals.get(g);
  };

  const addPark = (s, reason, unparkList, ts) => {
    if (!s.parks.has(reason)) s.parks.set(reason, { unpark: normalizeUnpark(unparkList), ts });
  };

  for (const f of facts) {
    switch (f.kind) {
      case 'goal-formed': {
        const s = ensure(f.goal);
        s.formed = true;
        if (f.goalType) s.goalType = f.goalType;
        if (f.title) s.title = f.title;
        break;
      }
      case 'dependency-declared':
        ensure(f.goal).deps.add(f.dependsOn);
        break;
      case 'goal-done': {
        const s = ensure(f.goal);
        s.done = true;
        s.stall = 0;
        break;
      }
      case 'artifact-produced': {
        const s = ensure(f.goal);
        s.artifacts.add(f.artifact);
        s.stall = 0;
        break;
      }
      case 'attempt': {
        const s = ensure(f.goal);
        s.stall += 1;
        if (s.stall >= STALL_THRESHOLD) {
          addPark(s, 'stall',
            ['artifact-produced', 'validity-verdict', 'operator-response', 'timeout'], f.ts);
        }
        break;
      }
      case 'park': {
        const s = ensure(f.goal);
        addPark(s, f.reason ?? 'unspecified', f.unpark, f.ts);
        break;
      }
      case 'unpark': {
        const s = ensure(f.goal);
        if (f.reason) s.parks.delete(f.reason);
        else s.parks.clear();
        s.stall = 0;
        break;
      }
      case 'budget-exhausted': {
        const s = ensure(f.goal);
        addPark(s, 'budget', ['heartbeat', 'operator-response'], f.ts);
        break;
      }
      case 'capability-asserted': caps.add(f.capability); break;
      case 'capability-revoked': caps.delete(f.capability); break;
      case 'contradiction': {
        const c = f.contradicts || {};
        switch (c.kind) {
          case 'goal-done':
            if (goals.has(c.goal)) goals.get(c.goal).done = false; // I1: re-enters a live bucket
            break;
          case 'dependency-declared':
            if (goals.has(c.goal)) goals.get(c.goal).deps.delete(c.dependsOn);
            break;
          case 'artifact-produced':
            if (goals.has(c.goal)) goals.get(c.goal).artifacts.delete(c.artifact);
            break;
          case 'park':
            if (goals.has(c.goal)) {
              if (c.reason) goals.get(c.goal).parks.delete(c.reason);
              else goals.get(c.goal).parks.clear();
            }
            break;
          case 'capability-asserted': caps.delete(c.capability); break;
          default: break; // contradiction of unmodelled target: inert
        }
        break;
      }
      default:
        break; // heartbeat / operator-response / timeout / body-observed /
               // validity-verdict move nothing directly — but see below
    }

    // Generic unpark firing: a park clears when a later fact of an anyOf kind
    // targets the parked goal. (The park fact itself must not self-fire.)
    if (f.kind !== 'park') {
      const target = factTarget(f);
      if (target != null && goals.has(target)) {
        const s = goals.get(target);
        for (const [reason, p] of s.parks) {
          if (!p.unpark.anyOf.some((d) => disjunctFires(d, f))) continue;
          if (f.kind === 'timeout') {
            // a timeout never fakes resolution — the blocker is still real.
            // It fires the disjunct by SURFACING the park as overdue (the
            // attention channel), keeping I3 liveness without the E0-04
            // failure of a park silently self-releasing.
            p.overdue = f.ts;
          } else {
            s.parks.delete(reason);
            s.stall = 0;
          }
        }
      }
    }
  }

  // ---- bucket assignment (total by construction) ---------------------------
  const formed = [...goals.entries()].filter(([, s]) => s.formed).map(([g]) => g);
  const notDone = new Set(formed.filter((g) => !goals.get(g).done));

  const edges = new Map();
  for (const g of notDone) {
    edges.set(g, new Set([...goals.get(g).deps].filter((d) => notDone.has(d))));
  }
  const cyclic = goalsInCycles(edges, notDone);

  const result = new Map();
  for (const g of formed) {
    const s = goals.get(g);
    const base = { goalType: s.goalType, title: s.title, artifacts: [...s.artifacts] };
    if (s.done) {
      result.set(g, { ...base, bucket: 'done' });
      continue;
    }
    if (s.parks.size > 0) {
      const parks = [...s.parks.entries()]
        .map(([reason, p]) => ({ reason, unpark: p.unpark, since: p.ts,
          ...(p.overdue ? { overdue: p.overdue } : {}) }))
        .sort((a, b) => ((a.since ?? '') < (b.since ?? '') ? -1 : 1));
      result.set(g, { ...base, bucket: 'parked', parks,
        reason: parks.map((p) => p.reason).join('+'),
        unpark: parks[0].unpark, parkedTs: parks[0].since });
      continue;
    }
    if (cyclic.has(g)) {
      const unpark = normalizeUnpark(['contradiction', 'operator-response']);
      result.set(g, { ...base, bucket: 'parked',
        parks: [{ reason: 'dependency_cycle', unpark, since: null }],
        reason: 'dependency_cycle', unpark, parkedTs: null });
      continue;
    }
    const unsatisfied = [...s.deps].filter((d) => notDone.has(d));
    if (unsatisfied.length > 0) {
      result.set(g, { ...base, bucket: 'waiting',
        dependency: unsatisfied[0], dependencies: unsatisfied });
      continue;
    }
    result.set(g, { ...base, bucket: 'ripe' });
  }

  return result;
}
