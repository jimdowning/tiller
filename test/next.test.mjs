import { test } from 'node:test';
import assert from 'node:assert/strict';
import { match, requirementsOf, operatorActions } from '../src/next.mjs';
import { fold } from '../src/classify.mjs';

const goalFormed = (goal, goalType = 'delivery', title = `Goal ${goal}`) =>
  ({ ts: '2026-07-01T00:00:00Z', seq: goal, kind: 'goal-formed', goal, goalType, title });

test('capability match skips past goals the session cannot serve — no head-of-line block', () => {
  const facts = [goalFormed(1), goalFormed(2)];
  const classification = fold(facts);
  const meta = new Map([
    [1, { labels: ['needs:build-stack'], focus: 'current' }], // higher priority, needs tools
    [2, { labels: [], focus: null }],
  ]);
  const webContainer = new Set(['agent', 'gh']);
  const { matched, skipped } = match(classification, meta, webContainer);
  assert.deepEqual(matched.map((r) => r.goal), [2]); // skipped #1, took #2
  assert.match(skipped.find((s) => s.goal === 1).why, /missing capability: build-stack/);

  const fullSession = new Set(['agent', 'gh', 'build-stack']);
  const both = match(classification, meta, fullSession);
  assert.deepEqual(both.matched.map((r) => r.goal), [1, 2]); // focus:current first
});

test('routeFloor fullteam derives an interactive requirement', () => {
  const req = requirementsOf({ bucket: 'ripe', parks: [] }, { labels: [], routeFloor: 'fullteam' });
  assert.ok(req.has('interactive'));
});

test('learned requirement: a capability park becomes a requirement', () => {
  const facts = [goalFormed(1),
    { ts: '2026-07-02T00:00:00Z', seq: 10, kind: 'park', goal: 1,
      reason: 'capability:build-stack', unpark: ['capability-asserted', 'operator-response'] }];
  const c = fold(facts).get(1);
  assert.equal(c.bucket, 'parked');
  assert.ok(requirementsOf(c, { labels: [] }).has('build-stack'));
});

test('operator projection: parked-on-operator exits and outstanding attestations', () => {
  const facts = [
    goalFormed(1, 'delivery', 'Needs stamp'),
    { ts: '2026-07-02T00:00:00Z', seq: 10, kind: 'park', goal: 1, reason: 'operator',
      unpark: ['operator-response', 'timeout'] },
    goalFormed(10, 'journey', 'Journey: onboarding'),
  ];
  const classification = fold(facts);
  const meta = new Map([[1, { labels: [] }], [10, { labels: ['goal:journey'] }]]);
  const acts = operatorActions(classification, meta, facts);
  assert.ok(acts.some((a) => a.goal === 1 && /resolve park: operator/.test(a.kind)));
  assert.ok(acts.some((a) => a.goal === 10 && /attest: journey-articulation/.test(a.kind)));
});
