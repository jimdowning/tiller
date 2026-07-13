import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepGate, newGoalState, KNOBS } from '../src/hysteresis.mjs';

function drive(signals, knobs = KNOBS, start = newGoalState()) {
  let state = start;
  const out = [];
  signals.forEach((raw, i) => {
    const r = stepGate(state, raw, i + 1, knobs);
    state = r.state;
    out.push({ dispatch: r.dispatch, holding: r.holding, state });
  });
  return out;
}

test('instant-up: a freshly-ripe goal dispatches on its very first ripe tick', () => {
  const out = drive([true, true, true, true]);
  assert.equal(out[0].dispatch, true);   // no hold-open on the first commit
  assert.equal(out[0].holding, false);
  assert.ok(out.every((o) => o.dispatch === true));
});

test('instant-up commits even on a signal that later flickers (the optimistic trade)', () => {
  // First ripe tick dispatches; the anti-thrash guard applies only AFTER a
  // de-commit, not to the first commit.
  const out = drive([true, false, true, false]);
  assert.equal(out[0].dispatch, true);
});

test('hysteresis: a committed goal survives a one-tick contradiction blip', () => {
  const out = drive([true, true, true, false, true, true]);
  assert.equal(out[2].dispatch, true);  // committed
  assert.equal(out[3].dispatch, true);  // blip absorbed (M=1.0 needs a saturated window)
  assert.equal(out[5].dispatch, true);
});

test('sustained loss of ripeness de-commits after the commit window', () => {
  const out = drive([true, true, true, false, false, false, false]);
  assert.equal(out[0].dispatch, true);  // instant commit
  const later = out.slice(4);
  assert.ok(later.some((o) => o.dispatch === false), 'eventually de-commits');
  assert.equal(out[out.length - 1].dispatch, false);
});

test('re-commit is DAMPED: after a de-commit, re-ripening holds W/K before re-dispatch', () => {
  const signals = [true, true, true, false, false, false, false, true, true, true, true];
  const out = drive(signals);
  // find the de-commit, then the first re-ripe tick after it
  const decommitIdx = out.findIndex((o, i) => i >= 3 && o.dispatch === false);
  assert.ok(decommitIdx > 0, 'a de-commit occurs');
  const firstReRipe = signals.findIndex((v, i) => i > decommitIdx && v === true);
  assert.equal(out[firstReRipe].dispatch, false, 'first re-ripe tick does NOT dispatch (damped)');
  assert.equal(out[firstReRipe].holding, true, 'it is held, not dispatched');
  assert.equal(out[out.length - 1].dispatch, true, 're-commits once the window is stable again');
});

test('migration: legacy committed state (no hasCommitted flag) stays committed', () => {
  const legacy = { signals: [1, 1, 1], committed: 'ripe', commitTick: 3 };
  const r = stepGate(legacy, true, 4);
  assert.equal(r.dispatch, true);
  assert.equal(r.state.hasCommitted, true);
});

test('migration: legacy de-committed state (commitTick set, not-ripe) re-commits DAMPED', () => {
  // A goal that committed then de-committed under the old model must be treated
  // as flicker-prone: its re-commit routes through the hold-open, not instant.
  const legacy = { signals: [0, 0, 0], committed: 'not-ripe', commitTick: 6 };
  const r1 = stepGate(legacy, true, 7);   // first re-ripe tick
  assert.equal(r1.dispatch, false, 'not instant — legacy de-commit is remembered');
  assert.equal(r1.state.hasCommitted, true);
});

test('migration: legacy never-committed state (commitTick null) dispatches instantly', () => {
  const legacy = { signals: [0, 0], committed: 'not-ripe', commitTick: null };
  const r = stepGate(legacy, true, 3);
  assert.equal(r.dispatch, true, 'never committed → instant first commit');
});
