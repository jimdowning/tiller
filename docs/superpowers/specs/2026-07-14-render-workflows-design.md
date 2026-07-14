# Design: `render-workflows` — mermaid workflow diagrams from tiller config

**Date:** 2026-07-14
**Status:** approved (brainstorm) → plan next
**Scope:** `jimdowning/tiller` (this repo). Lands direct-to-main, FF-push, per repo convention.

## Problem

A tiller repo defines one or more **workflows** — a goal type's ordered stages plus the
situational **gates** that guard progression. Today that lives only in config
(`src/templates.mjs` `GOAL_TYPES`, a consumer's `DELIVERY_TEMPLATE` override, and `GATES`
in the active config). There is no rendered, human-readable picture of these workflows, and
nothing keeps such a picture honest as config evolves. As topology grows (ADR 0001: stages
become a capability-typed DAG with fan-in/fan-out), the need for a generated diagram sharpens.

Add devx: a deterministic generator that renders each goal type's workflow as a mermaid
diagram and maintains it inside a marked section of the project `README.md`, plus a CI gate
that fails if the rendered section drifts from config.

## Non-goals

- No changes to the classifier, fold, templates data, or gate semantics. This is a
  **reporting** tool over existing config exports (continuous with "stages are reporting-only").
- Not building ADR 0001's DAG topology, capability profiles, or reasoned revalidation. The
  renderer is *structured* to accept them later (see Graph model), but today it renders the
  linear-stages + gates shape that exists.
- No new runtime dependencies. Zero-dep, `node --test`, consistent with the engine.

## Design

### First-class engine command: `src/diagram.mjs`

Sits alongside `tick` / `explain` / `attest` / `next` as a `TILLER_CONFIG`-aware command.
It imports the **already-resolved** config exports — never re-parses config — so the diagram
cannot disagree with what the classifier actually runs:

- `DELIVERY_TEMPLATE`, `GATES`, `RIPE_REQUIRES` from `src/config.mjs`
- `GOAL_TYPES` from `src/templates.mjs` (for the `journey` template and any non-overridden types)

Modes:

| Invocation | Behaviour |
| --- | --- |
| `node src/diagram.mjs` | Print the full mermaid section to stdout. |
| `node src/diagram.mjs --write [path]` | Rewrite the marked README section idempotently (default `README.md`). |
| `node src/diagram.mjs --check [path]` | Exit non-zero if the marked section differs from freshly-generated output. The CI gate. Prints a diff hint. |

### Graph model (ADR-0001-shaped, populated from today's config)

Internally the renderer consumes a normalized model, not the raw config, so future topology
slots in without touching rendering:

```
Workflow = {
  goalType: string,
  nodes: [{ id, kind: 'stage'|'gate', label, preds: string[], profile?: object }],
  ripeStageId: string,          // the stage gates attach to
  ripeRequires: { labels, labelPrefixes },
}
```

A thin **adapter** builds `Workflow`s from the current config shape:

- **Stages → a predecessor chain.** `stages = [s0, s1, …]` becomes stage nodes with
  `preds: [previous]` (degenerate DAG). When ADR 0001 lands and a goal type carries
  explicit nodes-with-predecessors, the adapter reads those instead; the renderer is unchanged.
- **`ripeStageId`** is the stage named `ripe` if present, else the stage whose entry the
  `ripeRequires` precondition guards (first non-initial stage). Gates and the ripeness
  precondition attach here.
- **Gates → guard nodes.** Each gate in `GATES` whose `appliesWhen.goalType` matches (or is
  absent) becomes a `kind: 'gate'` node with `preds: []`, rendered as a dashed guard into
  `ripeStageId`. Its label carries `id`, the `appliesWhen` situation (`bodyCites` /
  `labelsInclude`), `authority`, required `artifact`, and `mode` (shadow/enforce).
- **`profile`** is a forward-compat passthrough: rendered as a node annotation only when a
  node carries one (none do today).

### Mermaid rendering

One `flowchart` (`graph LR`) per goal type, each under an `###` subheading:

- Stage nodes: rounded `("shaped")`. Chain edges `shaped --> ripe --> pr-open --> merged`.
- Ripeness precondition on the edge entering `ripeStageId`:
  `-->|requires: label 'shaped'|`.
- Gate nodes: hexagon `{{"classifier-fuzz<br/>when: cites src/(classify|schema).mjs<br/>authority: sensor · artifact: fuzz-run · shadow"}}`
  with a dashed edge `-.gate.-> ripe`. `enforce` gates get a distinct class/style so
  shadow-vs-enforce reads at a glance.

Deterministic ordering (config order for stages and gates; goal types in a fixed order) so
output is stable and `--check` is meaningful.

### README section

A `## Workflows` section fenced by HTML-comment markers:

```
<!-- tiller:workflows:start -->
… generated content …
<!-- tiller:workflows:end -->
```

The writer replaces only the content between markers, preserving surrounding prose. If the
markers are absent, `--write` errors with instructions to add the section (never guesses a
location). A short static preamble above the markers (not regenerated) explains what the
diagrams are. Placed near "Issues-only state model" / "Situational gates".

### Config source for this repo's README

CI renders from **`tiller.config.mjs`** (the self-hosted thin template that actually governs
this repo) via `TILLER_CONFIG=./tiller.config.mjs`, not the `engine.config.mjs` fallback —
so the README is an honest tiller-on-tiller picture that exercises the `DELIVERY_TEMPLATE`
override and the real `classifier-fuzz` / `classifier-spec-sync` gates. One-line reversible
choice, isolated to the CI step and the skill.

### CI gate

Add a step to `.github/workflows/ci.yml` next to tests/fuzz/spec:

```
TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md
```

Fails the build if a config change is not reflected in the README diagrams.

### Skill: `.claude/skills/render-workflows/SKILL.md`

Tiller has no `.claude/` yet; this creates it. Thin skill — it documents when to run the
generator (after any config/template/gate change) and the exact `--write` / `--check`
invocations, and reminds the operator the CI gate enforces sync. No hand-authoring of
mermaid; the script is the single source.

## Tests — `test/diagram.test.mjs` (`node --test`)

Against a small in-test fixture config (a couple of goal types + a shadow gate + an enforce
gate + a gate scoped by `appliesWhen`):

1. **Structure:** one flowchart per goal type; stage chain edges in config order; each gate
   attached to the right `ripeStageId`; a gate scoped to a non-matching goal type does **not**
   appear in the other's flowchart; enforce vs shadow styled distinctly.
2. **Idempotence:** `--write` then `--check` on the result is clean (exit 0); a second
   `--write` is a no-op.
3. **Drift detection:** `--check` against a hand-mutated section exits non-zero.
4. **Missing markers:** `--write` on content without markers errors clearly.

## Consequences

- The README gains a self-updating, CI-guarded map of the repo's workflows.
- The renderer is the same tool a consumer runs against their own `TILLER_CONFIG` to
  document their workflows — general engine capability, not a tiller-repo-only script.
- Structuring around the graph model means ADR 0001's DAG topology and capability profiles
  extend the **adapter**, not the renderer or the README/CI plumbing.

## Rollout

Direct commit to `main` (via a fast-forward from the isolation worktree branch), FF-push. No
submodule pin bump in strengthsys is required for this devx addition; the operator can bump
the pin separately if/when desired.
