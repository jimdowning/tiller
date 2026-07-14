import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatFact } from '../src/heartbeat.mjs';
import { fold } from '../src/classify.mjs';
import { FactStore } from '../src/store.mjs';

test('heartbeatFact: numeric source is coerced to a Number (matches goal keys)', () => {
  const f = heartbeatFact('42', '2026-07-14T00:00:00Z');
  assert.deepEqual(f, { ts: '2026-07-14T00:00:00Z', kind: 'heartbeat', source: 42 });
});

test('heartbeatFact: a non-numeric source stays a stream-name string', () => {
  const f = heartbeatFact('supervise-prs', '2026-07-14T00:00:00Z');
  assert.deepEqual(f, { ts: '2026-07-14T00:00:00Z', kind: 'heartbeat', source: 'supervise-prs' });
});

// The emit-side payoff: a goal parked on budget-exhausted (unpark anyOf
// ['heartbeat', 'operator-response']) is released when a heartbeat whose
// source IS that goal number lands — this is why numeric coercion matters.
test('a heartbeat sourced at a goal fires its budget-exhausted unpark', () => {
  const store = new FactStore();
  store.appendAll([
    { ts: '2026-07-14T00:00:00Z', kind: 'goal-formed', goal: 42, goalType: 'delivery', title: 'x' },
    { ts: '2026-07-14T00:00:01Z', kind: 'budget-exhausted', goal: 42 },
  ]);
  assert.equal(fold(store.all()).get(42).bucket, 'parked');
  assert.match(fold(store.all()).get(42).reason, /budget/);

  store.append(heartbeatFact('42', '2026-07-14T00:00:02Z'));
  assert.equal(fold(store.all()).get(42).bucket, 'ripe');
});

// A stream-name heartbeat is a valid liveness pulse but targets no goal, so it
// releases nothing — the (separate) absence-side timeout is what consumes it.
test('a stream-name heartbeat releases no goal park', () => {
  const store = new FactStore();
  store.appendAll([
    { ts: '2026-07-14T00:00:00Z', kind: 'goal-formed', goal: 42, goalType: 'delivery', title: 'x' },
    { ts: '2026-07-14T00:00:01Z', kind: 'budget-exhausted', goal: 42 },
  ]);
  store.append(heartbeatFact('loop', '2026-07-14T00:00:02Z'));
  assert.equal(fold(store.all()).get(42).bucket, 'parked');
});
