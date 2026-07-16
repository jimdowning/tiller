// Frontier-starvation surfacing (#25): when ripe = holding = 0 with parked
// goals present, the snapshot flags the globally-stuck shape the per-goal
// wedge audit can't see, with a park-reason histogram and unpark events
// ranked by how many goals each would touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../src/sense/translate.mjs';
import { fold } from '../src/classify.mjs';
import { buildSnapshot, starvationReadout, renderMarkdown } from '../src/tick.mjs';

const NOW = '2026-07-16T12:00:00Z';

const issue = (n, over = {}) => ({
  number: n, isPR: false, title: `goal ${n}`, body: '', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', closedAt: null,
  labels: [], events: [], comments: [], ...over,
});

const snapOf = (items) => {
  const { facts, meta } = translate(items, new Map(), NOW);
  return buildSnapshot(fold(facts), meta, null, [], NOW, 1);
};

test('starvationReadout: histogram + unpark ranking, deterministic order', () => {
  const parked = [
    { goal: 1, parks: [{ reason: 'needs-conditioning', unpark: ['artifact-produced:conditioned'] }] },
    { goal: 2, parks: [{ reason: 'needs-conditioning', unpark: ['artifact-produced:conditioned'] }] },
    { goal: 3, parks: [{ reason: 'operator', unpark: ['operator-response', 'timeout'] }] },
  ];
  const r = starvationReadout(parked);
  assert.deepEqual(r.reasons, [
    { reason: 'needs-conditioning', count: 2 },
    { reason: 'operator', count: 1 },
  ]);
  assert.deepEqual(r.unparks[0], {
    event: 'artifact-produced:conditioned', count: 2, goals: [1, 2],
  });
});

test('an all-parked plan is marked starved, with the readout attached', () => {
  const snap = snapOf([issue(1), issue(2), issue(3)]); // unconditioned → all park
  assert.equal(snap.counts.ripe, 0);
  assert.equal(snap.starved, true);
  assert.equal(snap.starvation.reasons[0].reason, 'needs-conditioning');
  assert.equal(snap.starvation.reasons[0].count, 3);
  const md = renderMarkdown(snap);
  assert.match(md, /Frontier empty — nothing is dispatchable/);
  assert.match(md, /needs-conditioning ×3/);
  assert.match(md, /`artifact-produced:conditioned` → 3 goals \(#1, #2, #3\)/);
});

test('one ripe goal is enough: not starved, no section rendered', () => {
  const snap = snapOf([
    issue(1, { labels: ['conditioned', 'blast-radius:isolated', 'reversibility:easy'] }),
    issue(2),
  ]);
  assert.equal(snap.counts.ripe, 1);
  assert.equal(snap.starved, false);
  assert.equal(snap.starvation, null);
  assert.doesNotMatch(renderMarkdown(snap), /Frontier empty/);
});

test('an empty repo (nothing parked) is not starved', () => {
  const snap = snapOf([]);
  assert.equal(snap.starved, false);
});
