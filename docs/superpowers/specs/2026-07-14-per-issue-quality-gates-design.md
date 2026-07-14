# Design: per-issue quality gates (ADR 0003)

**Date:** 2026-07-14
**Status:** approved (brainstorm) → ADR + config next
**Scope:** `jimdowning/tiller` (this repo). Lands direct-to-main, FF-push, per repo convention.

## Problem

Tiller's thin delivery template makes an issue ripe on a single `shaped` label — there is
no articulated bar for *what makes an issue well-formed enough to start* nor *what makes an
implemented change good enough to merge*. We want a **minimal, explicit quality-gate set per
issue**, expressed in tiller's own gate model (situational, authority-typed, shadow-first),
covering five concerns:

1. **Value is clear** — a feature states what value it adds and to whom; infrastructure
   states what capability it adds; a bug states how critical it is.
2. **Alternatives were considered** — the adopted solution's rationale is justified against
   alternatives.
3. **The approach is specified in allium** — preferably with a superpowers design doc too.
4. **Implementation is verified** — automated tests wherever possible.
5. **Other quality gates** — code review by a *different model* than the implementer; docs
   updated w.r.t. the change; the change fits the existing architecture or extends it in a
   reasoned, documented way.

## The one structural constraint

Today's `GATES` array (`gates.mjs` `evaluateGates`) parks a **live (not-done)** goal until a
passing `validity-verdict` fact for the gate's `artifact` exists. That is **pre-dispatch
(ripeness) gating only** — a gate cannot express a *merge* condition. A naive "tests-pass"
ripeness gate deadlocks: you must implement to produce tests, but cannot be dispatched to
implement until tests pass.

Merge-gating requires the ADR-0001 development-template **DAG** (nodes-with-predecessors,
where `reviewed` / `verified` are enforce-able downstream nodes) — tracked as **#17**. So the
five concerns split by *when they are assessable*:

- **Pre-dispatch gates** concern the *plan / approach* → ship **now** as real shadow `GATES`
  entries. Enforceable on today's engine.
- **Delivery gates** concern the *implemented change* → **specified now** (ADR + contributor
  process + CI), enforce-able as DAG nodes only **on #17**. tiller records and *reports*
  their verdicts in the snapshot but does not block merge until #17 lands.

This is not a compromise imposed by laziness — it is the honest shape of the engine today,
and it keeps delivery gates observable (shadow / report) before they are binding, exactly as
ADR 0001 axis 5 and ADR 0002 axis 3 prescribe.

## The gate set

`kind` = pre-dispatch (real `GATES` entry now) | delivery (specified now, enforced on #17).
All new gates start `mode: 'shadow'` and graduate to `enforce` one at a time on their own
divergence record.

| # | Gate id | Tier (appliesWhen) | Kind | Authority | Verdict produced by |
|---|---------|--------------------|------|-----------|---------------------|
| 1 | `value-clear` | **always** | pre-dispatch | **operator** | agent drafts the value statement in the issue body → operator stamp via `attest.mjs` |
| 2 | `alternatives-considered` | nontrivial | pre-dispatch | agent | agent judges alternatives + adopted-solution rationale are present → agent-sourced verdict |
| 3 | `spec-present` | **always**¹ | pre-dispatch | agent | agent judges an allium spec specifying the adopted approach exists and checks clean (`allium check`/`analyse`) → agent-sourced verdict |
| 4 | `arch-fit` | nontrivial | pre-dispatch | **operator** | operator stamps that the specced approach fits the architecture or documents the extension |
| 5 | `tests-pass` | **always** | delivery | sensor | CI (`node --test` + `fuzz`) → `validity-verdict` (the #12 CI-sensor) |
| 6 | `code-review` | decision-bearing | delivery | agent² | a reviewer agent on a **different model** than the implementer → agent-sourced verdict |
| 7 | `docs-updated` | user-facing | delivery | agent | agent judges the docs reflect the change → agent-sourced verdict |

¹ `spec-present` binds on every delivery issue, with an explicit **`mechanical` label
opt-out** (ADR 0002's plumbing carve-out — plumbing skips the spec). The safe default is
*spec-required*; a change is actively declared `mechanical` to opt out, and that opt-out is
recorded as the gate's verdict. Behavior-defining changes never opt out.

² tiller cannot verify "different model" from its fact log — it has no record of which model
implemented. The different-model requirement is a **process rule in the ADR and the review
skill**, not a machine check; tiller only records that a `code-review` pass verdict exists.

### Authority scheme (the operator-toil lever)

Chosen: **agent-certifies; operator stamps `value-clear` + `arch-fit` only.** This applies
ADR 0002's principle — *the operator stamps only what is genuinely not the agent's to give* —
to the gate set. What is valuable, and whether a change fits the architecture, are operator
judgments; everything else an agent can credibly certify or a command can decide.

- **sensor:** `tests-pass`.
- **agent:** `alternatives-considered`, `spec-present`, `code-review`, `docs-updated`.
- **operator:** `value-clear`, `arch-fit` (plus the existing `journey-articulation`).

Note: the engine default (`engine.config.mjs`) carries a `spec-check-clean` **sensor** gate
(mechanical `allium check`/`analyse`) that tiller's own `tiller.config.mjs` does **not** yet
include. `spec-present` (agent) subsumes "checks clean" as part of adequacy for now; porting
the `spec-check-clean` sensor gate into `tiller.config.mjs` as a mechanical adjunct is a
reasonable optional follow-up, deliberately not bundled here to keep the set minimal.

### appliesWhen scheme (minimal per issue)

Chosen: **two-tier — universal core + situational extras.**

- **Universal** (bind on `{ goalType: 'delivery' }`): `value-clear`, `spec-present`,
  `tests-pass`.
- **Situational** (bind on a single label — `gateApplies` matches one `labelsInclude`, not a
  prefix, so each tier is one label):
  - `nontrivial` → `alternatives-considered` + `arch-fit`
  - `decision-bearing` → `code-review` (the `{architectural, irreversible, cost}` + UI set
    from ADR 0001)
  - `user-facing` → `docs-updated`

The situational labels are applied by the conditioning agent when it judges the change so.
Because the universal core always binds, a forgotten situational label can only *under*-gate
a change down to the core — it can never leave an issue entirely ungated.

## Config sketch (`tiller.config.mjs` — the 4 pre-dispatch gates)

Delivery gates 5–7 are **not** added to `GATES` (they would deadlock as ripeness gates); they
live in the ADR as the contributor bar and become DAG nodes on #17. Only the four
pre-dispatch gates are added now, all shadow:

```js
// appended to GATES in tiller.config.mjs — all mode:'shadow'
{ id: 'value-clear', authority: 'operator', mode: 'shadow',
  appliesWhen: { goalType: 'delivery' },
  requires: { artifact: 'value-clear', source: 'operator' } },

{ id: 'spec-present', authority: 'agent', mode: 'shadow',
  appliesWhen: { goalType: 'delivery' },            // mechanical-label opt-out handled below
  requires: { artifact: 'spec-present' } },

{ id: 'alternatives-considered', authority: 'agent', mode: 'shadow',
  appliesWhen: { goalType: 'delivery', labelsInclude: 'nontrivial' },
  requires: { artifact: 'alternatives-considered' } },

{ id: 'arch-fit', authority: 'operator', mode: 'shadow',
  appliesWhen: { goalType: 'delivery', labelsInclude: 'nontrivial' },
  requires: { artifact: 'arch-fit', source: 'operator' } },
```

**`mechanical` opt-out for `spec-present`.** `gateApplies` has no "exclude if label present"
predicate. Two ways to honor the opt-out without an engine change:
(a) the `mechanical` label carries a *recorded pass* verdict for `spec-present` (an
`attest.mjs` stamp, or a sensor that passes when `mechanical` is present); or
(b) accept it as a process convention while shadow (the gate reports would-park; the operator
ignores it for `mechanical` issues) and revisit when it graduates to enforce.
**Recommendation:** (b) during shadow — zero engine change, and the graduation decision for
`spec-present` is exactly where the opt-out mechanism earns being built. Flagged as an open
item for the enforce-graduation of `spec-present`.

The `tests-pass` sensor verdict rides the #12 CI-sensor work; no new `SENSORS` entry is added
now beyond noting the dependency.

## Rollout

1. **ADR 0003** (prose — consistent with ADR 0002's rejection of speccing the process in
   allium) records the decision; this design doc is its detailed companion.
2. **4 pre-dispatch gates** added to `tiller.config.mjs` `GATES`, `mode: 'shadow'`.
3. **3 labels** created: `nontrivial`, `decision-bearing`, `user-facing`.
4. **README "Workflows" section regenerated** (`node src/diagram.mjs --write README.md`) so
   the diagram-drift CI gate stays green — the new gates render as guard nodes.
5. **Delivery gates 5–7** specified in the ADR as the contributor bar; enforcement deferred
   to #17 (DAG) and tests' CI-sensor to #12. A pointer is added to #17.
6. **Dogfood** a self-tick; confirm the four gates report in the snapshot's shadow section
   against the open issues, and commit the snapshot as evidence.

## Deliberately not doing (YAGNI)

- **No new engine code** (per the build-vs-spec decision) — only `GATES` entries + labels +
  the README regen the existing diagram tool already supports.
- **No capability profiles / reasoned revalidation** — that is #17 / ADR 0001.
- **No `enforce` mode on day one** — everything ships shadow, so the current open issues are
  not retroactively frozen; each gate graduates on its own divergence record.
- **No enforcement of "different model" for `code-review`** in the engine — a process rule.

## Open items

- The `mechanical` opt-out mechanism for `spec-present` is decided only for the shadow phase
  (process convention); its enforce-graduation must pick mechanism (a) or a small engine
  predicate. Revisit at graduation.
- Delivery-gate enforcement (5–7 as DAG nodes) is entirely dependent on #17.

## References

- ADR 0001 — development-template DAG substrate (the enforcement substrate for delivery gates)
- ADR 0002 — thin, contract-first development workflow (authority classes, shadow-first)
- #17 — implement the ADR-0001 DAG substrate (delivery-gate enforcement dependency)
- #12 — CI as a sensor-authority attesting agent (`tests-pass` verdict producer)
