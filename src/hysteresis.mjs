// hysteresis.mjs — the I4 anti-thrash gate on ripeness, per goal, across ticks.
//
// ASYMMETRIC by operator decision (2026-07-11): dispatch latency is the live
// cost and premature ripening has never occurred (0 down-flickers over the
// first 4 live ticks / 150 goals), while the raw signal is still a clean
// deterministic classifier output (real flicker risk is the future
// LLM-as-judge-with-confidence era, not yet wired). So the gate is optimistic
// on the way UP and damped on the way DOWN:
//
//   • FIRST ripening dispatches IMMEDIATELY — a goal that has never committed
//     commits the moment its raw signal is ripe. No hold-open.
//   • DE-COMMIT stays damped — a committed goal is abandoned only past the
//     commit window and margin (E3 hysteresis, unchanged).
//   • RE-COMMIT (the "second time") is damped — once a goal has been
//     de-committed, it has proven flicker-prone, so re-ripening must clear the
//     W/K hold-open again before re-dispatching. This is where W/K still bite.
//
// E3's original verdict (hold-open on EVERY commit + hysteresis) bounded thrash
// in the synthetic run; here we keep the down-side damping (the load-bearing
// half) but drop hold-open on the first commit, restoring it only after a
// goal has actually shown it can flicker. Revisit if the LLM-judge signal
// lands and first-commit thrash starts to bite — reinstating hold-open on the
// first commit is a one-line change (drop the `!hasCommitted` fast path).
//
// The engine's raw signal per goal per tick is binary: classifier bucket ===
// 'ripe' ? 1 : 0. The E3 knobs map as:
//   W  — stability window: raw signal unchanged for the last W ticks
//        (now governs RE-commit only, not the first commit)
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
  return { signals: [], committed: 'not-ripe', commitTick: null, hasCommitted: false };
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
 *   holding  — raw signal is ripe but the gate has not committed yet (only
 *              possible during a DAMPED re-commit, after a prior de-commit)
 */
export function stepGate(prev, rawRipe, tick, knobs = KNOBS) {
  const { W, K, M, commitWindow } = knobs;
  // Migrate gate state persisted before the asymmetric change (no hasCommitted
  // flag): a goal that is committed now, or was committed and later
  // de-committed (commitTick set while not committed), has committed before.
  const hasCommitted =
    prev.hasCommitted ?? (prev.committed === 'ripe' || prev.commitTick != null);
  const state = {
    ...prev,
    hasCommitted,
    signals: [...prev.signals, rawRipe ? 1 : 0].slice(-HISTORY),
  };
  const s = smoothed(state.signals, K);
  const isStable = stable(state.signals, W);

  if (state.committed === 'not-ripe') {
    // Commit path (asymmetric). The FIRST ripening dispatches immediately —
    // no hold-open. A goal that has already been de-committed once has proven
    // flicker-prone, so its RE-commit must clear the W/K hold-open (saturated
    // smoothed signal over a stable window) before dispatching again.
    const firstCommit = !state.hasCommitted && rawRipe;
    const dampedRecommit = state.hasCommitted && isStable && s >= 1;
    if (firstCommit || dampedRecommit) {
      state.committed = 'ripe';
      state.commitTick = tick;
      state.hasCommitted = true;
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
