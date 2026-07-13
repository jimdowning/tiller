import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../src/sense/translate.mjs';
import { fold, unparkIsLive } from '../src/classify.mjs';
import { dateGateFacts } from '../src/tick.mjs';
import { explain } from '../src/explain.mjs';
import { earliestStartOf } from '../src/templates.mjs';
import { FactStore } from '../src/store.mjs';

// A conditioned goal is otherwise ripe — so any non-ripe bucket here is the
// date gate at work, not conditioning.
const CONDITIONED = ['conditioned', 'blast-radius:isolated', 'reversibility:easy'];
const issue = (over = {}) => ({
  number: 179, isPR: false, title: 'Quota-mode test', body: '', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', closedAt: null,
  labels: CONDITIONED, events: [], comments: [], ...over,
});

// Mirror runTick's fact pipeline exactly: sense → fold → date-gate → fold.
// The ordering (body-observed appended before the date-gate park) is what lets
// the bodyHash-keyed park survive the same tick's body-observed unpark.
function tick(store, items, nowTs) {
  const { facts, meta } = translate(items, new Map(), nowTs);
  store.appendAll(facts);
  let classification = fold(store.all());
  store.appendAll(dateGateFacts(classification, meta, nowTs));
  classification = fold(store.all());
  return { classification, meta, facts: store.all() };
}

// --- marker parsing --------------------------------------------------------

test('earliestStartOf: body line, label, latest-wins, none, malformed', () => {
  assert.equal(earliestStartOf('earliest-start: 2026-07-25'), '2026-07-25');
  assert.equal(earliestStartOf('> earliest-start: 2026-07-25\nfoo'), '2026-07-25');
  assert.equal(earliestStartOf('EARLIEST-START: 2026-07-25'), '2026-07-25'); // case-insensitive
  assert.equal(earliestStartOf('', new Set(['gated-until:2026-08-01'])), '2026-08-01');
  // both present → most conservative (latest) wins
  assert.equal(
    earliestStartOf('earliest-start: 2026-07-25', new Set(['gated-until:2026-08-01'])),
    '2026-08-01');
  assert.equal(earliestStartOf('no marker here'), null);
  assert.equal(earliestStartOf('earliest-start: soon'), null); // not an ISO date
  assert.equal(earliestStartOf('earliest-start: 2026-13-99'), '2026-13-99'); // shape only; sensing trusts the marker
});

test('translate records the declared earliest-start in meta (no fact emitted)', () => {
  const { facts, meta } = translate(
    [issue({ body: 'Date-gated.\n\nearliest-start: 2026-07-25\n' })], new Map(),
    '2026-07-11T09:00:00Z');
  assert.equal(meta.get(179).earliestStart, '2026-07-25');
  // sensing stays declaration-only: no date-* fact leaks from translate
  assert.ok(!facts.some((f) => f.kind === 'date-gate' || f.kind === 'date-reached'));
});

// --- the reported bug (#11) ------------------------------------------------

test('#11: a conditioned, future-dated goal parks on date-gate — NOT ripe', () => {
  const store = new FactStore();
  const { classification } = tick(store,
    [issue({ body: 'earliest-start: 2026-07-25' })], '2026-07-11T09:00:00Z');
  const c = classification.get(179);
  assert.equal(c.bucket, 'parked');          // was the false-positive `ripe`
  assert.equal(c.reason, 'date-gate');
});

test('gated-until label parks the same way as the body line', () => {
  const store = new FactStore();
  const { classification } = tick(store,
    [issue({ labels: [...CONDITIONED, 'gated-until:2026-07-25'] })],
    '2026-07-11T09:00:00Z');
  assert.equal(classification.get(179).bucket, 'parked');
  assert.equal(classification.get(179).reason, 'date-gate');
});

test('gate clears itself the day the tick date reaches it — no operator action', () => {
  const store = new FactStore();
  const items = [issue({ body: 'earliest-start: 2026-07-25' })];
  assert.equal(tick(store, items, '2026-07-11T09:00:00Z').classification.get(179).bucket,
    'parked');
  // a later tick ON the gate date: today == earliest-start counts as reached
  const reached = tick(store, items, '2026-07-25T09:00:00Z').classification.get(179);
  assert.equal(reached.bucket, 'ripe');
});

test('a gate already in the past is ripe from the first tick', () => {
  const store = new FactStore();
  const { classification } = tick(store,
    [issue({ body: 'earliest-start: 2026-07-01' })], '2026-07-11T09:00:00Z');
  assert.equal(classification.get(179).bucket, 'ripe');
});

// --- marker mutation (re-derivation via body-observed) ---------------------

test('editing the marker to a later date re-derives the gate (still parked)', () => {
  const store = new FactStore();
  tick(store, [issue({ body: 'earliest-start: 2026-07-25' })], '2026-07-11T09:00:00Z');
  const moved = tick(store,
    [issue({ body: 'earliest-start: 2026-08-15' })], '2026-07-12T09:00:00Z');
  const c = moved.classification.get(179);
  assert.equal(c.bucket, 'parked');
  assert.equal(c.reason, 'date-gate');
  // the current (later) date is what explain surfaces
  assert.match(explain(179, moved.classification, moved.facts).text, /earliest-start 2026-08-15/);
});

test('removing the marker clears the gate on the next tick', () => {
  const store = new FactStore();
  assert.equal(tick(store, [issue({ body: 'earliest-start: 2026-07-25' })],
    '2026-07-11T09:00:00Z').classification.get(179).bucket, 'parked');
  const cleared = tick(store, [issue({ body: 'no gate anymore' })], '2026-07-12T09:00:00Z');
  assert.equal(cleared.classification.get(179).bucket, 'ripe');
});

test('an unrelated body edit does NOT defeat a still-future gate', () => {
  const store = new FactStore();
  tick(store, [issue({ body: 'earliest-start: 2026-07-25' })], '2026-07-11T09:00:00Z');
  // edit an unrelated part of the body; marker + future date unchanged
  const edited = tick(store,
    [issue({ body: 'Extra context added.\n\nearliest-start: 2026-07-25' })],
    '2026-07-12T09:00:00Z');
  assert.equal(edited.classification.get(179).bucket, 'parked');
  assert.equal(edited.classification.get(179).reason, 'date-gate');
});

// --- explain + liveness ----------------------------------------------------

test('explain reports the gate, its clearing date, and the auto-clear exit', () => {
  const store = new FactStore();
  const { classification, facts } = tick(store,
    [issue({ body: 'earliest-start: 2026-07-25' })], '2026-07-11T09:00:00Z');
  const r = explain(179, classification, facts);
  assert.equal(r.bucket, 'parked');
  assert.match(r.text, /## date-gate/);
  assert.match(r.text, /evidence: earliest-start 2026-07-25/);
  assert.match(r.text, /earliest-start date arrives .*no operator action/);
});

test('the date-gate park is live (references a producible kind), so no wedge', () => {
  const store = new FactStore();
  const { classification } = tick(store,
    [issue({ body: 'earliest-start: 2026-07-25' })], '2026-07-11T09:00:00Z');
  const park = classification.get(179).parks.find((p) => p.reason === 'date-gate');
  assert.ok(unparkIsLive(park.unpark));                 // I3: can in principle fire
  assert.ok(park.unpark.anyOf.includes('date-reached'));
  assert.ok(!park.overdue); // never surfaces as overdue: no timeout disjunct
});

test('determinism: re-running a tick at the same date reproduces the bucket', () => {
  const items = [issue({ body: 'earliest-start: 2026-07-25' })];
  const a = tick(new FactStore(), items, '2026-07-11T09:00:00Z').classification.get(179);
  const b = tick(new FactStore(), items, '2026-07-11T09:00:00Z').classification.get(179);
  assert.deepEqual(a, b);
});

test('a closed (done) date-gated goal is not resurrected into a park', () => {
  const store = new FactStore();
  const closed = issue({
    body: 'earliest-start: 2026-07-25', state: 'closed',
    events: [{ ts: '2026-07-05T00:00:00Z', event: 'closed' }],
  });
  const { classification } = tick(store, [closed], '2026-07-11T09:00:00Z');
  assert.equal(classification.get(179).bucket, 'done');
});
