import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRipe, operatorGated, approachUndecided, hardDependencyOpen, routeFloor } from '../src/verify.mjs';
import { fold } from '../src/classify.mjs';
import { manufactureTimeouts, verifierFacts, wedgeAudit } from '../src/tick.mjs';

const allDone = () => true;
const noneDone = () => false;

test('operator-gated: unresolved secret prerequisite blocks', () => {
  const g = operatorGated('Needs the ANTHROPIC_EVAL_API_KEY to be supplied before runs.');
  assert.equal(g.fail, true);
});

test('operator-gated: provisioned/negated key mentions do not block', () => {
  assert.equal(operatorGated('ANTHROPIC_EVAL_API_KEY provisioned 2026-06-27.').fail, false);
  assert.equal(operatorGated('runs key-free, deterministic double').fail, false);
});

test('approach fork blocks; ordinary prose does not', () => {
  assert.equal(approachUndecided('Pick ONE of: (a) clingo, (b) hand-rolled.').fail, true);
  assert.equal(approachUndecided('New dep requires re-vetting via the gate.').fail, true);
  assert.equal(approachUndecided('A clean, decided implementation plan.').fail, false);
});

test('hard dependency: line-scoped Depends-on with an open target blocks', () => {
  const body = 'Adds the widget.\n\nDepends on #42\n';
  const open = hardDependencyOpen(body, noneDone);
  assert.equal(open.fail, true);
  assert.deepEqual(open.deps, [42]);
  assert.equal(hardDependencyOpen(body, allDone).fail, false);
});

test('soft dependency mentions do not block', () => {
  const body = 'Related: #42 (soft dependency, not blocking).\n';
  assert.equal(hardDependencyOpen(body, noneDone).fail, false);
});

test('route floor annotates cross-cutting work, never blocks', () => {
  assert.equal(routeFloor('touches supabase/migrations/x.sql').routeFloor, 'fullteam');
  assert.equal(routeFloor('tweak a README sentence').routeFloor, 'inline');
  const v = verifyRipe('touches supabase/migrations/x.sql', allDone);
  assert.equal(v.pass, true);
  assert.equal(v.routeFloor, 'fullteam');
});

test('verifierFacts parks a failing ripe goal, body-keyed for re-check on edit', () => {
  const classification = fold([
    { ts: '2026-07-01T00:00:00Z', seq: 0, kind: 'goal-formed', goal: 1 },
  ]);
  const meta = new Map([[1, { number: 1, body: 'gated on an operator secret', bodyHash: 'aaa' }]]);
  const facts = verifierFacts(classification, meta, '2026-07-05T00:00:00Z');
  assert.equal(facts.length, 1);
  assert.match(facts[0].reason, /operator-gated/);
  assert.match(facts[0].key, /aaa/);
  // the park's unpark fires on body-observed → an edited body re-verifies
  const after = fold([
    { ts: '2026-07-01T00:00:00Z', seq: 0, kind: 'goal-formed', goal: 1 },
    { ...facts[0], seq: 1 },
    { ts: '2026-07-06T00:00:00Z', seq: 2, kind: 'body-observed', goal: 1, hash: 'bbb' },
  ]);
  assert.equal(after.get(1).bucket, 'ripe');
});

test('manufactureTimeouts converts a stale park into a timeout fact (I3)', () => {
  const classification = fold([
    { ts: '2026-01-01T00:00:00Z', seq: 0, kind: 'goal-formed', goal: 1 },
    { ts: '2026-01-02T00:00:00Z', seq: 1, kind: 'park', goal: 1, reason: 'operator',
      unpark: ['operator-response', 'timeout'] },
  ]);
  const fresh = manufactureTimeouts(classification, '2026-01-05T00:00:00Z');
  assert.equal(fresh.length, 0); // inside TTL
  const stale = manufactureTimeouts(classification, '2026-03-01T00:00:00Z');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].kind, 'timeout');
  assert.equal(stale[0].ref, 1);
});

test('wedgeAudit flags waiting-on-done (the E1 regex-bug class)', () => {
  const classification = new Map([
    [1, { bucket: 'waiting', dependencies: [2] }],
    [2, { bucket: 'done' }],
  ]);
  const w = wedgeAudit(classification);
  assert.equal(w.length, 1);
  assert.equal(w[0].reason, 'waiting-on-done');
});
