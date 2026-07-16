// tiller.config.mjs — tiller's OWN config: the engine sensing this repo
// (jimdowning/tiller), classifying its own goals. Dogfood ticks run from the
// repo root:
//
//   TILLER_CONFIG=./tiller.config.mjs node src/tick.mjs
//
// (Without TILLER_CONFIG the engine keeps the historical in-tree defaults —
// engine.config.mjs, state/ and snapshots/ under the engine root — so a bare
// checkout still behaves as documented. This file is the self-hosting
// instance, shaped exactly like a consumer repo's config.)

// Machine-local engine state: fact log, hysteresis memory, meta cache
// (gitignored — see .gitignore).
export const stateDir = '.tiller/state';

// Derived-plan snapshots, date-named → conflict-free (committed).
export const snapshotDir = '.tiller/snapshots';

// The sensed repo's root (sensor cwd) — this file lives at it.
export const repoRoot = '.';

// ---------------------------------------------------------------------------
// THIN delivery template (tiller#1). This repo runs a much lighter process
// than the consumer it was extracted from: the whole ripeness contract is one
// `shaped` label — no blast-radius taxonomy, no reversibility label, no
// ceremony floor. Stages: shaped → ripe → pr-open → merged (pr-open/merged
// derive from pr#N / pr#N-merged artifacts; direct-to-main commits skip both).
// ---------------------------------------------------------------------------
export const DELIVERY_TEMPLATE = {
  stages: ['shaped', 'ripe', 'pr-open', 'merged'],
  ripeRequires: { labels: ['shaped'], labelPrefixes: [] },
};

// ---------------------------------------------------------------------------
// GATES are SITUATIONAL: `appliesWhen` is a data predicate over what the
// engine knows about a goal — a gate binds only in the situations that make
// its prework necessary, never universally. Gates start in `mode: 'shadow'`
// (the tick reports what WOULD park; nothing blocks) and graduate to
// `mode: 'enforce'` individually, on their divergence record.
//
// `authority` says who DECIDES the verdict: 'sensor' = mechanically decided
// by a command; 'operator' = the verdict fact must carry source:'operator'
// (recorded via `node src/attest.mjs`) — an agent-sourced pass does not
// satisfy an operator gate.
//
// Day-one contract (tiller#1): a change to the classifier/fold requires
//   (1) a passing fuzz-run verdict (mechanical — the E2-port property fuzzer)
//   (2) a goal-liveness spec update, attested by the operator
// ---------------------------------------------------------------------------
// appliesWhen matches EXPLICIT path citations only. First dogfood tick
// datapoint (2026-07-10): a broader `\bclassifier\b|\bfold\b` prose match
// applied the gates to all six open issues — every seeded issue mentions the
// classifier in passing. Citing src/classify.mjs / src/schema.mjs is the
// declared signal that a goal touches the fold.
export const GATES = [
  {
    id: 'classifier-fuzz',
    description: 'classifier/fold changes carry a passing fuzz-run verdict (test/fuzz.mjs)',
    mode: 'shadow',
    authority: 'sensor',
    appliesWhen: { goalType: 'delivery', bodyCites: 'src/(classify|schema)\\.mjs' },
    requires: { artifact: 'fuzz-run' },
  },
  {
    id: 'classifier-spec-sync',
    description: 'classifier/fold changes update spec/goal-liveness.allium — operator-attested (attest.mjs)',
    mode: 'shadow',
    authority: 'operator',
    appliesWhen: { goalType: 'delivery', bodyCites: 'src/(classify|schema)\\.mjs' },
    requires: { artifact: 'spec-sync', source: 'operator' },
  },

  // -------------------------------------------------------------------------
  // ADR 0003 — per-issue quality gates (PRE-DISPATCH half). These concern the
  // plan/approach, so they gate ripeness and live here. The DELIVERY half
  // (tests-pass, code-review, docs-updated) concerns the implemented change;
  // it would deadlock as a ripeness gate, so it is specified in ADR 0003 as
  // the contributor merge bar and becomes enforce-able DAG nodes on #17.
  //
  // Two-tier appliesWhen: value-clear + spec-present bind on every delivery
  // goal (universal core); alternatives-considered + arch-fit bind only on a
  // `nontrivial`-labelled goal. Authority: agent-certifies, the operator
  // stamps only value-clear + arch-fit (ADR 0003 §authority scheme).
  //
  // spec-present binds universally with a `mechanical` opt-out (ADR 0002
  // plumbing carve-out) — during shadow the opt-out is a process convention
  // (the operator ignores the would-park for `mechanical` issues); the
  // enforce-graduation of spec-present decides the concrete mechanism.
  // -------------------------------------------------------------------------
  {
    id: 'value-clear',
    description: 'the issue states its value — feature: what value to whom; infra: what capability; bug: how critical (ADR 0003)',
    mode: 'shadow',
    authority: 'operator',
    appliesWhen: { goalType: 'delivery' },
    requires: { artifact: 'value-clear', source: 'operator' },
  },
  {
    id: 'spec-present',
    description: 'an allium spec specifies the adopted approach and checks clean — agent-certified; `mechanical` label opts out (ADR 0003)',
    mode: 'enforce',
    authority: 'agent',
    appliesWhen: { goalType: 'delivery' },
    requires: { artifact: 'spec-present' },
  },
  {
    // The mechanical adjunct to `spec-present` (ADR 0003 follow-up: "port the
    // engine-default spec-check-clean sensor gate"). Where spec-present is the
    // agent's coverage judgement ("a spec covers this issue's changes"), this
    // gate is the deterministic other half: any spec the issue CITES must pass
    // `allium check` + `analyse` with 0 errors/0 warnings. Ported verbatim from
    // engine.config.mjs; binds only when a `spec/*.allium` path is cited, so it
    // enforces cleanliness of cited specs, not presence (that is spec-present).
    // Straight to `mode: 'enforce'` by operator decision (2026-07-16): the check
    // is deterministic and low-false-positive, so it skips the shadow-first
    // divergence-record graduation the other gates follow.
    id: 'spec-check-clean',
    description: 'cited Allium specs pass `allium check` + `analyse` with 0 errors/warnings (ADR 0003 follow-up)',
    mode: 'enforce',
    authority: 'sensor',
    appliesWhen: { goalType: 'delivery', bodyCites: 'spec/[A-Za-z0-9_-]+\\.allium' },
    requires: { artifact: 'spec-check' },
  },
  {
    id: 'alternatives-considered',
    description: 'alternatives were considered and the adopted-solution rationale justified — agent-certified (ADR 0003)',
    mode: 'shadow',
    authority: 'agent',
    appliesWhen: { goalType: 'delivery', labelsInclude: 'nontrivial' },
    requires: { artifact: 'alternatives-considered' },
  },
  {
    id: 'arch-fit',
    description: 'the approach fits the architecture or documents the extension — operator-attested (ADR 0003)',
    mode: 'shadow',
    authority: 'operator',
    appliesWhen: { goalType: 'delivery', labelsInclude: 'nontrivial' },
    requires: { artifact: 'arch-fit', source: 'operator' },
  },
];

export const SENSORS = {
  // artifact -> how to mechanically produce its validity verdict.
  'fuzz-run': {
    kind: 'command',
    command: ['node', 'test/fuzz.mjs', '5000'],
    // the files whose change invalidates a previous verdict (input-hash keyed)
    inputs: ['src/classify.mjs', 'src/schema.mjs', 'test/fuzz.mjs'],
  },
  // Backs the `spec-check-clean` gate: judges each spec cited in a goal body,
  // verdict input-hashed on the cited files' contents (editing a spec
  // re-triggers the check). info diagnostics are allowed.
  'spec-check': {
    kind: 'allium',
    commands: [['allium', 'check'], ['allium', 'analyse']],
    failOn: ['error', 'warning'],
  },
};
