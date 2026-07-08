import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepGate, newGoalState, KNOBS } from '../src/hysteresis.mjs';

function drive(signals, knobs = KNOBS) {
  let state = newGoalState();
  const out = [];
  signals.forEach((raw, i) => {
    const r = stepGate(state, raw, i + 1, knobs);
    state = r.state;
    out.push({ dispatch: r.dispatch, holding: r.holding });
  });
  return out;
}

test('hold-open: a goal ripe from tick 1 dispatches only after W stable ticks', () => {
  const out = drive([true, true, true, true]);
  assert.equal(out[0].dispatch, false);
  assert.equal(out[0].holding, true);
  assert.equal(out[1].dispatch, false);
  assert.equal(out[2].dispatch, true); // W=K=3 satisfied
  assert.equal(out[3].dispatch, true);
});

test('a single-tick flicker does not commit (premature-commit guard, E3 config a)', () => {
  const out = drive([true, false, true, false, true, false]);
  assert.ok(out.every((o) => o.dispatch === false));
});

test('hysteresis: a committed goal survives a one-tick contradiction blip', () => {
  const out = drive([true, true, true, false, true, true]);
  assert.equal(out[2].dispatch, true);  // committed
  assert.equal(out[3].dispatch, true);  // blip absorbed (M=1.0 needs a saturated window)
  assert.equal(out[5].dispatch, true);
});

test('sustained loss of ripeness de-commits after the commit window', () => {
  const out = drive([true, true, true, false, false, false, false]);
  assert.equal(out[2].dispatch, true);
  const later = out.slice(4);
  assert.ok(later.some((o) => o.dispatch === false), 'eventually de-commits');
  assert.equal(out[out.length - 1].dispatch, false);
});

test('de-commit then re-ripen re-commits after a fresh stable window', () => {
  const signals = [true, true, true, false, false, false, false, true, true, true, true];
  const out = drive(signals);
  assert.equal(out[out.length - 1].dispatch, true);
});
