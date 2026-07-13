// stage-reporting.test.mjs — the reporting-only stage derivation (#9).
//
// stageOf is a PURE lens over a goal's fold state + artifacts; the classifier's
// bucket logic never reads it. These tests pin each stage's evidence and the
// "furthest reached in template order" semantics, then confirm the stage
// surfaces as a column in the rendered snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageOf, GOAL_TYPES } from '../src/templates.mjs';
import { buildSnapshot, renderMarkdown } from '../src/tick.mjs';

// The thin per-repo template this repo runs on itself (tiller.config.mjs).
const THIN = { stages: ['shaped', 'ripe', 'pr-open', 'merged'] };
// The engine-default delivery template (no per-repo override).
const DEFAULT = GOAL_TYPES.delivery;

const goal = (bucket, artifacts = []) => ({ bucket, artifacts });

test('thin template: a shaped-but-parked goal reads `shaped`', () => {
  // ripeRequires satisfied (the `shaped` label → `conditioned` artifact) but
  // held out of ripe by some park.
  assert.equal(stageOf(goal('parked', ['conditioned']), ['conditioned'], THIN), 'shaped');
});

test('thin template: a dispatchable goal reads `ripe`', () => {
  assert.equal(stageOf(goal('ripe', ['conditioned']), ['conditioned'], THIN), 'ripe');
});

test('thin template: an open PR reads `pr-open`', () => {
  const a = ['conditioned', 'pr#42'];
  assert.equal(stageOf(goal('ripe', a), a, THIN), 'pr-open');
});

test('thin template: a merged PR reads `merged` (furthest, past the open-PR artifact)', () => {
  // translate.mjs emits BOTH pr#N and pr#N-merged on a merge; merged wins.
  const a = ['conditioned', 'pr#42', 'pr#42-merged'];
  assert.equal(stageOf(goal('done', a), a, THIN), 'merged');
});

test('thin template: an unshaped goal has reached no stage (null)', () => {
  assert.equal(stageOf(goal('parked', []), [], THIN), null);
});

test('gaps are tolerated: `merged` reads even with no intermediate artifacts', () => {
  // default template: conditioned → implemented → reviewed → merged → verified → done.
  // Only conditioned + the merge artifact are present; the last true stage wins.
  const a = ['conditioned', 'pr#7', 'pr#7-merged'];
  assert.equal(stageOf(goal('ripe', a), a, DEFAULT), 'merged');
});

test('default template: a conditioned-but-not-yet-implemented goal reads `conditioned`', () => {
  assert.equal(stageOf(goal('ripe', ['conditioned']), ['conditioned'], DEFAULT), 'conditioned');
});

test('conventional evidence: an artifact named for the stage lights that stage (#7 widening)', () => {
  const a = ['conditioned', 'implemented', 'reviewed'];
  assert.equal(stageOf(goal('ripe', a), a, DEFAULT), 'reviewed');
});

test('journey template: a journey ripens to `children-done` once its children are done', () => {
  assert.equal(stageOf(goal('ripe', []), [], GOAL_TYPES.journey), 'children-done');
  assert.equal(stageOf(goal('waiting', []), [], GOAL_TYPES.journey), null);
});

test('stage surfaces as a column in the rendered snapshot', () => {
  // buildSnapshot reads the ACTIVE delivery template from config (engine
  // default here — no TILLER_CONFIG in the test process).
  const classification = new Map([
    [1, { bucket: 'ripe', goalType: 'delivery', title: 'ripe goal', artifacts: ['conditioned'] }],
    [2, { bucket: 'ripe', goalType: 'delivery', title: 'merged goal',
      artifacts: ['conditioned', 'pr#9', 'pr#9-merged'] }],
    [3, { bucket: 'parked', goalType: 'delivery', title: 'raw goal', artifacts: [],
      reason: 'needs-conditioning', parks: [{ reason: 'needs-conditioning',
        unpark: { anyOf: ['artifact-produced:conditioned'] }, since: '2026-07-01T00:00:00Z' }] }],
  ]);
  const snap = buildSnapshot(classification, new Map(), null, [], '2026-07-13T00:00:00Z', 1);
  assert.equal(snap.ripe.find((r) => r.goal === 1).stage, 'conditioned');
  assert.equal(snap.ripe.find((r) => r.goal === 2).stage, 'merged');
  assert.equal(snap.parked.find((r) => r.goal === 3).stage, null);

  const md = renderMarkdown({ ...snap, gates: { met: [], wouldPark: [] } });
  assert.match(md, /#1 ripe goal · stage:conditioned/);
  assert.match(md, /#2 merged goal · stage:merged/);
  // an unstaged goal renders no stage annotation
  assert.doesNotMatch(md, /#3 raw goal · stage:/);
});
