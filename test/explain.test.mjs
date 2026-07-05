import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explain } from '../src/explain.mjs';
import { fold } from '../src/classify.mjs';

const F = [
  { ts: '2026-07-01T00:00:00Z', seq: 0, kind: 'goal-formed', goal: 1, title: 'A blocked goal' },
  { ts: '2026-07-01T00:00:00Z', seq: 1, kind: 'park', goal: 1, reason: 'needs-conditioning',
    unpark: ['artifact-produced:conditioned'] },
  { ts: '2026-07-02T00:00:00Z', seq: 2, kind: 'park', goal: 1, reason: 'untracked-dependency',
    unpark: ['dependency-declared', 'operator-response', 'timeout'],
    evidence: ['blocked by an unmerged, untracked dependency'] },
  { ts: '2026-07-03T00:00:00Z', seq: 3, kind: 'timeout', ref: 1 },
];

test('explain renders every active park with humanized exits and overdue flag', () => {
  const r = explain(1, fold(F), F);
  assert.equal(r.bucket, 'parked');
  assert.match(r.text, /2 active blockers — ALL must clear/);
  assert.match(r.text, /needs-conditioning/);
  assert.match(r.text, /conditioning contract .*operator stamp/);
  assert.match(r.text, /untracked-dependency\s+⚠ OVERDUE/);
  assert.match(r.text, /evidence: blocked by an unmerged/);
  assert.match(r.text, /file\/link a tracking issue/);
});

test('explain reports the hysteresis hold on a raw-ripe goal', () => {
  const facts = [{ ts: '2026-07-01T00:00:00Z', seq: 0, kind: 'goal-formed', goal: 2, title: 'Fresh' }];
  const r = explain(2, fold(facts), facts, { 2: { signals: [1], committed: 'not-ripe', commitTick: null } });
  assert.match(r.text, /held by the hysteresis gate/);
});

test('explain is honest about unsensed goals', () => {
  const r = explain(999, fold([]), []);
  assert.equal(r.found, false);
  assert.match(r.text, /not sensed yet/);
});
