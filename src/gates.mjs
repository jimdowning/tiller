// gates.mjs — situational readiness gates over the fold.
//
// A gate = (situation predicate) → (required validity verdict). Evaluation is
// pure: given the classification, per-goal meta, and the fact log, each
// applicable gate on a live goal is either MET (a passing verdict from the
// right authority exists) or would park. In shadow mode the result is
// reported only; in enforce mode the tick appends a park fact whose unpark is
// the qualified disjunct `validity-verdict:<artifact>` — which only a PASSING
// verdict fires (see disjunctFires).

export function gateApplies(gate, c, m) {
  const w = gate.appliesWhen || {};
  if (w.goalType && c.goalType !== w.goalType) return false;
  if (w.labelsInclude && !(m?.labels ?? []).includes(w.labelsInclude)) return false;
  if (w.bodyCites && !(m?.body && new RegExp(w.bodyCites, 'i').test(m.body))) return false;
  return true;
}

/** Latest validity verdict for (goal, artifact), by fold order. */
export function latestVerdict(facts, goal, artifact) {
  let best = null;
  for (const f of facts) {
    if (f.kind !== 'validity-verdict' || f.goal !== goal || f.artifact !== artifact) continue;
    if (!best || f.ts > best.ts || (f.ts === best.ts && (f.seq ?? 0) > (best.seq ?? 0))) best = f;
  }
  return best;
}

/**
 * Evaluate all gates over all live (not done, not external) goals.
 * Returns { met: [...], wouldPark: [...], parkFacts: [...] } — parkFacts only
 * for gates in enforce mode.
 */
export function evaluateGates(gates, classification, meta, facts, nowTs) {
  const met = [];
  const wouldPark = [];
  const parkFacts = [];
  for (const [goal, c] of classification) {
    if (c.bucket === 'done' || c.goalType === 'external') continue;
    const m = meta.get(goal);
    for (const gate of gates) {
      if (!gateApplies(gate, c, m)) continue;
      const v = latestVerdict(facts, goal, gate.requires.artifact);
      const sourceOk = !gate.requires.source || v?.source === gate.requires.source;
      if (v && v.verdict === 'pass' && sourceOk) {
        met.push({ goal, gate: gate.id });
        continue;
      }
      const detail = !v
        ? `no ${gate.requires.artifact} verdict yet (authority: ${gate.authority})`
        : v.verdict !== 'pass'
          ? `latest verdict: fail${v.counts ? ` (${JSON.stringify(v.counts)})` : ''}`
          : `verdict source '${v.source ?? 'unknown'}' lacks required authority '${gate.requires.source}'`;
      wouldPark.push({ goal, gate: gate.id, mode: gate.mode, detail });
      if (gate.mode === 'enforce') {
        parkFacts.push({
          ts: nowTs, kind: 'park', goal, reason: `gate:${gate.id}`,
          unpark: [`validity-verdict:${gate.requires.artifact}`, 'operator-response'],
          key: `gate-park:${goal}:${gate.id}:${v?.inputHash ?? 'none'}`,
        });
      }
    }
  }
  return { met, wouldPark, parkFacts };
}
