// templates.mjs — goal-type registry + the issues-only state conventions.
//
// ISSUES-ONLY: the engine reads NO milestones. Every state signal the
// milestone system carried maps to an issue-level construct:
//
//   milestone construct              issues-only construct
//   ------------------------------   -----------------------------------------
//   milestone membership             journey issue body task-list (`- [ ] #N`)
//                                    or a `Part of #N` line in the child body
//   `[CURRENT]` / `[NEXT]` marker    `focus:current` / `focus:next` label on
//                                    the journey issue
//   "PO todo" milestone              `po-todo` label
//   milestone completion counting    DERIVED: a journey is ripe-to-close when
//                                    all its declared children are done. No
//                                    self-count is possible (E0-11) because
//                                    doneness is a dependency-graph property,
//                                    not an "all issues in bucket closed" count.
//
// Goal types are read from `goal:*` labels; an unlabelled issue is a plain
// delivery goal. Each template lists ordered stages whose completion is
// derived from artifact-produced facts (reporting only in the preliminary
// engine — the classifier's bucket logic does not depend on stages).

export const GOAL_TYPES = {
  // A deliverable unit of work (the default; E1's DELIVERY_TEMPLATE).
  delivery: {
    label: null, // default when no goal:* label present
    stages: ['conditioned', 'implemented', 'reviewed', 'merged', 'verified', 'done'],
    // ripeness precondition: the conditioning contract (dispatch gate, P9)
    ripeRequires: { conditioned: true },
  },
  // A user journey: an issue whose body task-list declares its children.
  // It waits on its children; once all are done it ripens for its own
  // closing decision (the operator's journey-transition call — the analogue
  // of the old milestone-transition escalation, now just a ripe goal).
  journey: {
    label: 'goal:journey',
    stages: ['elaborated', 'children-done', 'closed'],
    ripeRequires: {}, // a journey's readiness is purely its children's doneness
  },
};

export function goalTypeOf(labels) {
  for (const [type, t] of Object.entries(GOAL_TYPES)) {
    if (t.label && labels.has(t.label)) return type;
  }
  return 'delivery';
}

// --- Stage reporting (#9) --------------------------------------------------
// The furthest template stage a goal has reached, derived from its
// artifact-produced facts and fold state. REPORTING ONLY: the classifier's
// bucket logic (classify.mjs) never reads a stage — stages are a human-facing
// lens over the same artifacts, rendered as a column in the snapshot. Keeping
// bucket assignment stage-free is the #9 constraint, and why this derivation
// lives here rather than in the fold.
const PR_OPEN_ARTIFACT = /^pr#\d+$/;
const PR_MERGED_ARTIFACT = /^pr#\d+-merged$/;

// Evidence that a named stage has been REACHED, over (goal, artifacts). Two
// kinds:
//   - structural — the fold's own state (`bucket`) or the PR artifacts
//     translate.mjs emits (`pr#N`, `pr#N-merged`);
//   - conventional — any stage NOT listed here is reached when an artifact of
//     the same name was produced (the artifact-name == stage-name convention;
//     e.g. `implemented` / `reviewed` / `verified` once the widening senses of
//     #7 emit them).
// `shaped`/`conditioned` both map to the `conditioned` artifact: satisfying the
// ripeRequires labels (a lone `shaped` label under the thin template) is what
// translate.mjs records as `artifact-produced: conditioned`, whatever the
// gating label is named.
export const STAGE_EVIDENCE = {
  shaped: (_g, a) => a.includes('conditioned'),
  conditioned: (_g, a) => a.includes('conditioned'),
  ripe: (g) => g.bucket === 'ripe',
  'children-done': (g) => g.bucket === 'ripe', // a journey ripens once children are done
  'pr-open': (_g, a) => a.some((x) => PR_OPEN_ARTIFACT.test(x)),
  merged: (_g, a) => a.some((x) => PR_MERGED_ARTIFACT.test(x)),
  done: (g) => g.bucket === 'done',
  closed: (g) => g.bucket === 'done',
};

function stageReached(stage, goal, artifacts) {
  const ev = STAGE_EVIDENCE[stage];
  return ev ? ev(goal, artifacts) : artifacts.includes(stage);
}

/**
 * The furthest stage `goal` has reached in `template`, or null if it has not
 * reached the first stage. Reporting only — never consulted by the fold.
 *
 * "Furthest" is the LAST stage in template order whose evidence holds, so gaps
 * are tolerated: a merged goal reads `merged` even when no artifact yet
 * evidences the intermediate `implemented`/`reviewed` stages (a widening-sense
 * follow-on, #7).
 *
 * @param goal      a folded goal — needs `.bucket`
 * @param artifacts the goal's artifact-produced names (`goal.artifacts`)
 * @param template  { stages: string[] } — the delivery or journey template
 */
export function stageOf(goal, artifacts = [], template = GOAL_TYPES.delivery) {
  let reached = null;
  for (const stage of template?.stages ?? []) {
    if (stageReached(stage, goal, artifacts)) reached = stage;
  }
  return reached;
}

// Focus markers (replace [CURRENT]/[NEXT] milestone-name markers).
export const FOCUS_LABELS = { 'focus:current': 'current', 'focus:next': 'next' };

// The conditioning contract a ripe delivery goal must carry (P9 / E0-04).
export const RIPE_REQUIRES = {
  labels: ['conditioned'],
  labelPrefixes: ['blast-radius:', 'reversibility:'],
};

// Operator-park signals — labels only (the "PO todo" milestone becomes the
// `po-todo` label). An unresolved **ACTION REQUIRED** comment also parks.
export const OPERATOR_SIGNAL = {
  labels: ['needs-operator', 'escalation', 'po-todo'],
  labelPrefixes: ['escalate:'],
};

// Comment-borne dependency-block sensing (from E1, incl. the E6 regex fix:
// no bare `under` alternative — it false-matched "under-specified").
export const DEP_BLOCK_PATTERNS = [
  /startable:\s*`?no[^a-z]*—?\s*(?:blocked|work[- ]sequenc)/i,
  /work[- ]sequencing block/i,
  /blocked by (?:a )?(?:not-yet-built )?sibling/i,
  /blocked\s+—\s+needs?\s+(?:a\s+)?(?:sibling|dependency)/i,
  /depends on (?:the )?(?:not-yet-built|unbuilt|sibling)/i,
];
export const DEP_REF = /\b(?:blocked by|depends on|folded into|sibling)\s+#?(\d+)/i;
export const STARTABLE_YES = /startable:\s*`?yes/i;
export const RESOLVER = /\*\*FYI\*\*|startable:\s*`?yes|re-conditioned|conditioned.*applied|contract completed/i;

// Body-borne membership sensing (issues-only journey structure).
export const TASK_LIST_ITEM = /^\s*[-*]\s*\[( |x|X)\]\s*.*?#(\d+)/gm;
export const PART_OF = /\bpart of #(\d+)/i;

// Date-gate sensing (#11): an earliest-start marker keeps an otherwise-ripe
// goal OUT of `ripe` until the tick date reaches it — a first-class "not yet
// time" gate, distinct from "not yet understood" (unconditioned). Two
// equivalent declared forms:
//   - a body line `earliest-start: YYYY-MM-DD`
//   - a `gated-until:YYYY-MM-DD` label
// When both are present the LATEST (most conservative) date wins.
export const EARLIEST_START = /^[ \t>*-]*earliest-start:\s*(\d{4}-\d{2}-\d{2})\b/im;
export const GATED_UNTIL_LABEL = 'gated-until:';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The declared earliest-start date (ISO YYYY-MM-DD) for a goal, or null. */
export function earliestStartOf(body = '', labels = new Set()) {
  const dates = [];
  const m = body.match(EARLIEST_START);
  if (m) dates.push(m[1]);
  for (const l of labels) {
    if (!l.startsWith(GATED_UNTIL_LABEL)) continue;
    const d = l.slice(GATED_UNTIL_LABEL.length).trim();
    if (ISO_DATE.test(d)) dates.push(d);
  }
  if (!dates.length) return null;
  // most conservative: the latest gate. ISO dates sort lexically.
  return dates.sort().at(-1);
}

// Meta-tracker prefixes still excluded from the goal population — PURE
// bookkeeping only. Journeys are NOT here: they are genuine goals now.
export const META_TRACKER_PREFIXES = ['Elaboration:', 'Roadmap', '[Roadmap]'];

// Timeout manufacture TTLs (days a park may sit before the tick appends a
// `timeout` fact, converting "still blocked" absence into an appendable fact
// that fires the park's manufactured timeout disjunct — E2's I3 repair).
export const TIMEOUT_TTL_DAYS = {
  operator: 14,
  'untracked-dependency': 14,
  'needs-conditioning': 30,
  default: 30,
};
