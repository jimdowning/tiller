// hysteresis.mjs — the I4 anti-thrash gate on ripeness, per goal, across ticks.
//
// E3's verdict: hold-open (first commit only once stable) + hysteresis
// (committed state abandoned only past a margin, after a commit window)
// bounds thrash; hold-open alone does not. Day-one knobs from e3-ripeness/knobs.md.
//
// The engine's raw signal per goal per tick is binary: classifier bucket ===
// 'ripe' ? 1 : 0. The E3 knobs map as:
//   W  — stability window: raw signal unchanged for the last W ticks
//   K  — moving average of the raw signal over the last K ticks
//   M  — margin-to-switch, in smoothed-signal units on [0,1]: a committed
//        state flips only when the challenger's evidence beats it by ≥ M/2
//        each side of 0.5 (M=1.0 ⇒ flip only on a saturated window)
//   commitWindow — min ticks committed before a flip is considered
//
// Windows are TICK-counted (each tick is a fact-event batch), matching E3's
// "prefer event-count over wall-clock" guidance.
export const KNOBS = { W: 3, K: 3, M: 1.0, commitWindow: 2 };

const HISTORY = 8; // ticks of raw signal retained per goal (≥ max(W, K))

export function newGoalState() {
  return { signals: [], committed: 'not-ripe', commitTick: null };
}

function smoothed(signals, K) {
  const win = signals.slice(-K);
  if (!win.length) return 0;
  return win.reduce((a, b) => a + b, 0) / win.length;
}

function stable(signals, W) {
  if (signals.length < W) return false; // hold open until W ticks observed
  const win = signals.slice(-W);
  return win.every((v) => v === win[0]);
}

/**
 * Advance one goal's gate by one tick.
 * @returns {{state: object, dispatch: boolean, holding: boolean}}
 *   dispatch — the committed view says "ripe": safe to hand to the dispatcher
 *   holding  — raw signal is ripe but the gate has not committed yet (hold-open)
 */
export function stepGate(prev, rawRipe, tick, knobs = KNOBS) {
  const { W, K, M, commitWindow } = knobs;
  const state = {
    ...prev,
    signals: [...prev.signals, rawRipe ? 1 : 0].slice(-HISTORY),
  };
  const s = smoothed(state.signals, K);
  const isStable = stable(state.signals, W);

  if (state.committed === 'not-ripe') {
    // hold-open: first commit to ripe only when smoothed signal is saturated
    // AND the window is stable (E3: W/K govern when you first commit)
    if (isStable && s >= 1) {
      state.committed = 'ripe';
      state.commitTick = tick;
    }
  } else {
    // hysteresis: de-commit only past the commit window and the margin
    // (E3: M/cw govern whether you re-commit). With M=1.0 this requires a
    // fully contradicting window (s === 0), filtering single-tick flickers.
    const held = state.commitTick == null || (tick - state.commitTick) >= commitWindow;
    if (held && (0.5 - s) >= M / 2) {
      state.committed = 'not-ripe';
      state.commitTick = tick;
    }
  }

  return {
    state,
    dispatch: state.committed === 'ripe',
    holding: rawRipe === true && state.committed !== 'ripe',
  };
}
