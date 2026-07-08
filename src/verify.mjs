// verify.mjs — the thin deterministic verifier over ripe candidates (E4's
// verdict: three checks earn their keep; the path-floor is a safe minimum for
// ceremony, not a router). Pure predicates over issue-body text + the current
// goal fold. No LLM, no deps.
//
//   1. operatorGated       — a genuine external prerequisite (named secret /
//                            explicit gating phrase) is unresolved
//   2. approachUndecided   — an explicit unresolved implementation fork,
//                            especially a dependency-vetting branch
//   3. hardDependencyOpen  — a line-scoped "Depends on #N" / "blocked by #N"
//                            where #N is a NOT-DONE goal in the current fold
//                            (E4's OPEN_AT_DECISION, made live)
//   +  routeFloor          — blast-radius floor from cited paths/keywords;
//                            annotates the route, never blocks
//
// A fired gate parks the goal with a body-keyed park: the park's logical key
// includes the body hash, so an EDITED body re-observes (body-observed fires
// the unpark) and the verifier re-runs against the new text — liveness by
// construction, no manual unpark needed.

// ---- 1. operator-gated prerequisite (E4 c2, precision-tightened form) ------
const SECRET_TOKEN = [
  /\bANTHROPIC[_A-Z]*KEY\b/, /\b[A-Z][A-Z0-9]{2,}_(API_)?KEY\b/,
  /\bAPI[- ]?key\b/i, /\bapi[- ]?secret\b/i,
];
const GATING_PHRASE = [
  /operator input[^.\n]{0,30}gating/i, /gating[^.\n]{0,30}operator input/i,
  /operator-supplied/i, /operator must (provide|supply)/i,
  /gated on (an? )?(operator|secret|key|external account|credential)/i,
  /blocked on[^.\n]{0,40}(secret|api key|credential|external account|operator)/i,
  /requires?[^.\n]{0,25}(secret|api key|credential|external account)/i,
  /\bhard-?block(ed)?\b[^.\n]{0,40}(secret|key|operator|account)/i,
];
const KEY_NEGATION = /\b(no|without|key-free|deterministic|resolved|provisioned|met|cleared|✅)\b/i;
export function operatorGated(body) {
  const hits = [];
  for (const line of body.split('\n')) {
    for (const re of SECRET_TOKEN) {
      if (re.test(line) && !KEY_NEGATION.test(line)
          && /\b(require|need|supplied|provision|secret|blocked|prerequisite|gated|await)\b/i.test(line))
        hits.push(line.match(re)[0]);
    }
    for (const re of GATING_PHRASE) {
      if (re.test(line) && !/\b(resolved|met|provisioned|no longer|cleared|✅)\b/i.test(line))
        hits.push(line.match(re)[0]);
    }
  }
  return { name: 'operator-gated', fail: hits.length > 0, evidence: [...new Set(hits)].slice(0, 5) };
}

// ---- 2. approach undecided / dep-vetting fork (E4 c3) -----------------------
const APPROACH_FORK = [
  /pick one of/i, /pick\s+ONE\s+of/, /choose one of/i,
  /requires? re-?vetting/i, /dependency[- ]vetting/i,
  /\bapproach is undecided\b/i, /one of the following approaches/i,
];
export function approachUndecided(body) {
  const hits = [];
  for (const re of APPROACH_FORK) { const m = body.match(re); if (m) hits.push(m[0]); }
  return { name: 'approach-undecided', fail: hits.length > 0, evidence: [...new Set(hits)].slice(0, 5) };
}

// ---- 3. hard dependency on a not-done goal (E4 c4's earning core) -----------
const DEP_SOFT = /\b(soft dependency|not blocking|not a #?\d* ?dependency|independent|out of scope|defer to|covered by|separate milestone|post-merge|lives in)\b/i;
const DEP_HARD_LINE = /^\s*(depends on|after|blocked by)\s+#?\d+/i;
const DEP_HARD_TAIL = /\b(depends on|blocked by) #\d+\.?\s*$/i;
export function hardDependencyOpen(body, isDone) {
  const hits = [];
  const deps = [];
  for (const line of body.split('\n')) {
    if (!(DEP_HARD_LINE.test(line) || DEP_HARD_TAIL.test(line)) || DEP_SOFT.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) {
      const n = Number(m[1]);
      if (!isDone(n)) {
        hits.push(`hard dependency on open #${n}`);
        deps.push(n);
      }
    }
  }
  return { name: 'hard-dependency-open', fail: hits.length > 0,
    evidence: [...new Set(hits)].slice(0, 5), deps: [...new Set(deps)] };
}

// ---- route floor (annotation only — a safe minimum, not a router) -----------
const CROSS_CUTTING_PATH = [
  /supabase\/functions\//i, /supabase\/migrations\//i,
  /\bspec\/[a-z0-9_-]+\.allium\b/i, /\.github\/workflows\//i,
];
const CROSS_CUTTING_KEYWORD = [
  /\bRLS\b/, /\brow[- ]level security\b/i, /\bmigration\b/i,
  /\bedge function\b/i, /\bauth(entication)?\b/i, /\bpolicy\b/i,
];
export function routeFloor(body) {
  const matched = [];
  for (const re of [...CROSS_CUTTING_PATH, ...CROSS_CUTTING_KEYWORD]) {
    const m = body.match(re);
    if (m) matched.push(m[0]);
  }
  const crossCutting = matched.length > 0;
  return { name: 'route-floor', routeFloor: crossCutting ? 'fullteam' : 'inline',
    evidence: [...new Set(matched)].slice(0, 6) };
}

/**
 * Verify one ripe candidate. `isDone(n)` answers from the current fold.
 * Returns { pass, gates, routeFloor, deps } — deps are hard dependencies the
 * caller should also record as dependency-declared facts (they are real edges
 * the comment-sensing may have missed).
 */
export function verifyRipe(body, isDone) {
  const g1 = operatorGated(body);
  const g2 = approachUndecided(body);
  const g3 = hardDependencyOpen(body, isDone);
  const floor = routeFloor(body);
  const fired = [g1, g2, g3].filter((g) => g.fail);
  return {
    pass: fired.length === 0,
    gates: fired.map((g) => ({ name: g.name, evidence: g.evidence })),
    routeFloor: floor.routeFloor,
    deps: g3.deps,
  };
}
