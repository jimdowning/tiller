// schema.mjs — the canonical fact vocabulary (engine core).
//
// Every fact is { ts, seq, kind, ...payload }.
//   ts   — ISO timestamp of the event the fact records (stable across ticks:
//          sensing derives it from GitHub event/comment timestamps, so
//          re-sensing the same history re-produces byte-identical facts and
//          content-dedup makes ticks idempotent).
//   seq  — global append counter, assigned by the store; the deterministic
//          tie-breaker for same-ts facts.
//   key  — optional LOGICAL identity. Facts that are re-derived each tick from
//          mutable state (issue bodies, verifier verdicts) rather than from a
//          timestamped event carry a `key`; the store dedups on it so
//          re-observation is a no-op. Event-derived facts omit it and dedup on
//          full content.
//
// Kinds (E2 vocabulary + the SYNTHESIS §"corrections" additions:
// heartbeat, timeout, and the untracked-dependency park reason):
//
//   goal-formed          { goal, goalType, title }
//   dependency-declared  { goal, dependsOn }        -- goal waits on dependsOn
//   artifact-produced    { goal, artifact }         -- progress (resets stall)
//   validity-verdict     { goal, artifact, verdict, inputHash }
//   goal-done            { goal }
//   attempt              { goal }                   -- a no-progress try (I3)
//   park                 { goal, reason, unpark: [factKind, ...] }
//   unpark               { goal }
//   budget-exhausted     { goal }
//   heartbeat            { source }                 -- liveness pulse from a stream
//   operator-response    { ref }                    -- the operator acted on `ref`
//   timeout              { ref }                    -- manufactured absence→fact
//   body-observed        { goal, hash }             -- issue body (re)read; hash-keyed
//   capability-asserted  { capability }
//   capability-revoked   { capability }
//   contradiction        { contradicts: { kind, ...matchFields } }
//                        -- flips a derived predicate WITHOUT deleting the
//                           contradicted fact (invariant I1)

export const PRODUCIBLE_FACT_KINDS = new Set([
  'goal-formed',
  'dependency-declared',
  'artifact-produced',
  'validity-verdict',
  'goal-done',
  'attempt',
  'park',
  'unpark',
  'budget-exhausted',
  'heartbeat',
  'operator-response',
  'timeout',
  'body-observed',
  'capability-asserted',
  'capability-revoked',
  'contradiction',
]);

export const BUCKETS = ['ripe', 'parked', 'waiting', 'done'];

// Stable, sorted-key JSON so identical facts serialise identically
// (content-dedup ⇒ idempotent ticks, invariant I3 no-hot-loop).
export function canonicalKey(fact) {
  const { seq, ...rest } = fact; // seq is store-assigned, not identity
  const sortedStringify = (v) => {
    if (Array.isArray(v)) return `[${v.map(sortedStringify).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedStringify(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
  };
  return fact.key ?? sortedStringify(rest);
}

// The goal(s) a fact is "about", for generic unpark firing.
export function factTarget(fact) {
  return fact.goal ?? fact.ref ?? fact.source ?? null;
}
