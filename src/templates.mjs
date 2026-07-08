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
