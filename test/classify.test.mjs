import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, unparkIsLive, normalizeUnpark } from '../src/classify.mjs';

const T = (i) => `2026-07-0${1 + Math.floor(i / 10)}T0${i % 10}:00:00Z`;
let seq = 0;
const f = (kind, rest, i = 0) => ({ ts: T(i), seq: seq++, kind, ...rest });

test('totality: every formed goal lands in exactly one bucket', () => {
  const out = fold([
    f('goal-formed', { goal: 1 }),
    f('goal-formed', { goal: 2 }, 1),
    f('goal-done', { goal: 2 }, 2),
    f('goal-formed', { goal: 3 }, 1),
    f('dependency-declared', { goal: 3, dependsOn: 1 }, 2),
    f('goal-formed', { goal: 4 }, 1),
    f('park', { goal: 4, reason: 'operator', unpark: ['operator-response'] }, 2),
  ]);
  assert.equal(out.size, 4);
  assert.equal(out.get(1).bucket, 'ripe');
  assert.equal(out.get(2).bucket, 'done');
  assert.equal(out.get(3).bucket, 'waiting');
  assert.equal(out.get(4).bucket, 'parked');
});

test('generic unpark firing: operator-response clears an operator park', () => {
  const out = fold([
    f('goal-formed', { goal: 1 }),
    f('park', { goal: 1, reason: 'operator', unpark: ['operator-response', 'timeout'] }, 1),
    f('operator-response', { ref: 1 }, 2),
  ]);
  assert.equal(out.get(1).bucket, 'ripe');
});

test('qualified disjunct: only the named artifact unparks', () => {
  const parked = fold([
    f('goal-formed', { goal: 1 }),
    f('park', { goal: 1, reason: 'needs-conditioning',
      unpark: ['artifact-produced:conditioned', 'operator-response'] }, 1),
    f('artifact-produced', { goal: 1, artifact: 'pr#9' }, 2),
  ]);
  assert.equal(parked.get(1).bucket, 'parked');
  const unparked = fold([
    f('goal-formed', { goal: 1 }),
    f('park', { goal: 1, reason: 'needs-conditioning',
      unpark: ['artifact-produced:conditioned', 'operator-response'] }, 1),
    f('artifact-produced', { goal: 1, artifact: 'conditioned' }, 2),
  ]);
  assert.equal(unparked.get(1).bucket, 'ripe');
});

test('untracked-dependency park unparks when a tracking edge appears (E6 #419)', () => {
  const facts = [
    f('goal-formed', { goal: 1 }),
    f('park', { goal: 1, reason: 'untracked-dependency',
      unpark: ['dependency-declared', 'operator-response', 'timeout'] }, 1),
  ];
  assert.equal(fold(facts).get(1).bucket, 'parked');
  facts.push(f('goal-formed', { goal: 2 }, 2));
  facts.push(f('dependency-declared', { goal: 1, dependsOn: 2 }, 3));
  const out = fold(facts);
  assert.equal(out.get(1).bucket, 'waiting'); // now waiting on a REAL edge
  assert.deepEqual(out.get(1).dependencies, [2]);
});

test('I1: contradiction of goal-done re-enters a live bucket, never deletes', () => {
  const out = fold([
    f('goal-formed', { goal: 1 }),
    f('goal-done', { goal: 1 }, 1),
    f('contradiction', { contradicts: { kind: 'goal-done', goal: 1 } }, 2),
  ]);
  assert.equal(out.get(1).bucket, 'ripe');
});

test('dependency cycle parks the cycle members with a live unpark', () => {
  const out = fold([
    f('goal-formed', { goal: 1 }),
    f('goal-formed', { goal: 2 }),
    f('goal-formed', { goal: 3 }),
    f('dependency-declared', { goal: 1, dependsOn: 2 }, 1),
    f('dependency-declared', { goal: 2, dependsOn: 1 }, 1),
    f('dependency-declared', { goal: 3, dependsOn: 1 }, 1), // feeder, not cyclic
  ]);
  assert.equal(out.get(1).bucket, 'parked');
  assert.equal(out.get(1).reason, 'dependency_cycle');
  assert.equal(out.get(2).bucket, 'parked');
  assert.equal(out.get(3).bucket, 'waiting'); // feeds the cycle, stays waiting
  assert.ok(unparkIsLive(out.get(1).unpark));
});

test('I3: a non-producible unpark predicate is repaired with timeout', () => {
  const p = normalizeUnpark(['operator-still-absent']);
  assert.ok(p.anyOf.includes('timeout'));
  assert.deepEqual(p.manufactured, ['timeout']);
  assert.ok(unparkIsLive(p));
});

test('idempotence: folding duplicated facts equals folding once', () => {
  const facts = [
    f('goal-formed', { goal: 1 }),
    f('park', { goal: 1, reason: 'operator', unpark: ['operator-response'] }, 1),
    f('operator-response', { ref: 1 }, 2),
  ];
  const once = fold(facts);
  const twice = fold([...facts, ...facts]);
  assert.deepEqual([...twice.entries()], [...once.entries()]);
});

test('journey semantics: waits on children, ripens when all done (no E0-11 self-count)', () => {
  const facts = [
    f('goal-formed', { goal: 10, goalType: 'journey', title: 'Journey: onboarding' }),
    f('goal-formed', { goal: 11 }),
    f('goal-formed', { goal: 12 }),
    f('dependency-declared', { goal: 10, dependsOn: 11 }, 1),
    f('dependency-declared', { goal: 10, dependsOn: 12 }, 1),
    f('goal-done', { goal: 11 }, 2),
  ];
  let out = fold(facts);
  assert.equal(out.get(10).bucket, 'waiting');
  assert.deepEqual(out.get(10).dependencies, [12]);
  facts.push(f('goal-done', { goal: 12 }, 3));
  out = fold(facts);
  assert.equal(out.get(10).bucket, 'ripe'); // ripe for its closing decision
  assert.equal(out.get(10).goalType, 'journey');
});

test('timeout surfaces a stale park as overdue, never silently releases it', () => {
  const facts = [
    f('goal-formed', { goal: 1 }),
    f('park', { goal: 1, reason: 'operator', unpark: ['operator-response', 'timeout'] }, 1),
    f('timeout', { ref: 1 }, 2),
  ];
  const out = fold(facts);
  assert.equal(out.get(1).bucket, 'parked'); // E0-04 guard: no silent self-release
  assert.ok(out.get(1).parks[0].overdue);
  // a real operator response still clears it
  facts.push(f('operator-response', { ref: 1 }, 3));
  assert.equal(fold(facts).get(1).bucket, 'ripe');
});
