import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateApplies, latestVerdict, evaluateGates } from '../src/gates.mjs';
import { fold } from '../src/classify.mjs';
import { GATES } from '../engine.config.mjs';

const NOW = '2026-07-05T12:00:00Z';
const specGate = GATES.find((g) => g.id === 'spec-check-clean');
const journeyGate = GATES.find((g) => g.id === 'journey-articulation');

const mkClassification = (facts) => fold(facts);
const goalFormed = (goal, goalType = 'delivery') =>
  ({ ts: '2026-07-01T00:00:00Z', seq: goal, kind: 'goal-formed', goal, goalType });

test('gates are situational: spec gate binds only when the body cites a spec', () => {
  const c = { goalType: 'delivery' };
  assert.equal(gateApplies(specGate, c, { body: 'touches spec/logging.allium here' }), true);
  assert.equal(gateApplies(specGate, c, { body: 'a README tweak' }), false);
  assert.equal(gateApplies(specGate, { goalType: 'journey' }, { body: 'spec/logging.allium' }), false);
});

test('journey gate binds by goal type, regardless of body', () => {
  assert.equal(gateApplies(journeyGate, { goalType: 'journey' }, { body: '' }), true);
  assert.equal(gateApplies(journeyGate, { goalType: 'delivery' }, { body: '' }), false);
});

test('missing verdict → would-park (shadow mode: reported, no park fact)', () => {
  const facts = [goalFormed(1)];
  const meta = new Map([[1, { body: 'implements spec/logging.allium', labels: [] }]]);
  const r = evaluateGates(GATES, mkClassification(facts), meta, facts, NOW);
  assert.deepEqual(r.wouldPark.map((w) => w.gate), ['spec-check-clean']);
  assert.match(r.wouldPark[0].detail, /no spec-check verdict yet/);
  assert.equal(r.parkFacts.length, 0); // shadow: nothing appended
});

test('a passing sensor verdict meets the spec gate; a fail does not', () => {
  const base = [goalFormed(1)];
  const meta = new Map([[1, { body: 'implements spec/logging.allium', labels: [] }]]);
  const withPass = [...base, { ts: NOW, seq: 10, kind: 'validity-verdict', goal: 1,
    artifact: 'spec-check', verdict: 'pass', source: 'sensor', inputHash: 'aaa' }];
  assert.deepEqual(evaluateGates(GATES, mkClassification(withPass), meta, withPass, NOW).met,
    [{ goal: 1, gate: 'spec-check-clean' }]);

  const withFail = [...base, { ts: NOW, seq: 10, kind: 'validity-verdict', goal: 1,
    artifact: 'spec-check', verdict: 'fail', source: 'sensor', counts: { warning: 2 } }];
  const r = evaluateGates(GATES, mkClassification(withFail), meta, withFail, NOW);
  assert.match(r.wouldPark[0].detail, /latest verdict: fail/);
});

test('operator authority: an agent-sourced pass does NOT meet the journey gate', () => {
  const facts = [goalFormed(10, 'journey'),
    { ts: NOW, seq: 10, kind: 'validity-verdict', goal: 10,
      artifact: 'journey-articulation', verdict: 'pass', source: 'sensor' }];
  const meta = new Map([[10, { body: 'Value: x', labels: ['goal:journey'] }]]);
  const r = evaluateGates(GATES, mkClassification(facts), meta, facts, NOW);
  assert.match(r.wouldPark[0].detail, /lacks required authority 'operator'/);

  const attested = [...facts, { ts: '2026-07-05T13:00:00Z', seq: 11, kind: 'validity-verdict',
    goal: 10, artifact: 'journey-articulation', verdict: 'pass', source: 'operator' }];
  assert.deepEqual(evaluateGates(GATES, mkClassification(attested), meta, attested, NOW).met,
    [{ goal: 10, gate: 'journey-articulation' }]);
});

test('latest verdict wins: an edit that breaks the spec supersedes the old pass', () => {
  const facts = [
    { ts: '2026-07-01T00:00:00Z', seq: 0, kind: 'validity-verdict', goal: 1,
      artifact: 'spec-check', verdict: 'pass', source: 'sensor', inputHash: 'aaa' },
    { ts: '2026-07-02T00:00:00Z', seq: 1, kind: 'validity-verdict', goal: 1,
      artifact: 'spec-check', verdict: 'fail', source: 'sensor', inputHash: 'bbb' },
  ];
  assert.equal(latestVerdict(facts, 1, 'spec-check').verdict, 'fail');
});

test('enforce mode parks with a qualified unpark that only a PASS fires', () => {
  const enforce = [{ ...specGate, mode: 'enforce' }];
  const facts = [goalFormed(1)];
  const meta = new Map([[1, { body: 'implements spec/logging.allium', labels: [] }]]);
  const r = evaluateGates(enforce, mkClassification(facts), meta, facts, NOW);
  assert.equal(r.parkFacts.length, 1);

  const parked = fold([...facts, { ...r.parkFacts[0], seq: 20 }]);
  assert.equal(parked.get(1).bucket, 'parked');
  // a FAILING verdict does not unpark...
  const stillParked = fold([...facts, { ...r.parkFacts[0], seq: 20 },
    { ts: '2026-07-06T00:00:00Z', seq: 21, kind: 'validity-verdict', goal: 1,
      artifact: 'spec-check', verdict: 'fail', source: 'sensor' }]);
  assert.equal(stillParked.get(1).bucket, 'parked');
  // ...a passing one does
  const released = fold([...facts, { ...r.parkFacts[0], seq: 20 },
    { ts: '2026-07-06T00:00:00Z', seq: 21, kind: 'validity-verdict', goal: 1,
      artifact: 'spec-check', verdict: 'pass', source: 'sensor' }]);
  assert.equal(released.get(1).bucket, 'ripe');
});
