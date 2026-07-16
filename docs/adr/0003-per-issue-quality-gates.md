---
adr: 0003
title: per-issue-quality-gates
status: proposed
date: 2026-07-14
supersedes: []
superseded_by: null
---

# ADR 0003: Per-issue quality gates — a two-tier set in tiller's own gate model

## Context

Tiller's thin delivery template (ADR 0002) makes an issue ripe on a single `shaped` label.
There is no articulated bar for **what makes an issue well-formed enough to start**, nor
**what makes an implemented change good enough to merge**. We want a *minimal, explicit*
quality-gate set per issue — expressed in tiller's own machinery (situational `appliesWhen`,
the three authority classes, shadow-first rollout), not as imported strengthsys ceremony —
covering five concerns: (1) value is clear; (2) alternatives were considered and the adopted
approach justified; (3) the approach is specified in allium (ideally with a superpowers design
doc); (4) implementation is verified with automated tests; (5) other quality gates — code
review by a *different model* than the implementer, docs updated, architectural fit.

One structural fact of the engine forces the shape. `gates.mjs` `evaluateGates` parks a
**live (not-done)** goal until a passing `validity-verdict` for the gate's artifact exists —
i.e. it can only express **pre-dispatch (ripeness)** gates. A "tests-pass" ripeness gate
would deadlock (you must implement to produce tests, but cannot be dispatched to implement
until tests pass). Merge-gating requires the ADR-0001 development-template **DAG**
(nodes-with-predecessors) — tracked as **#17**.

The full design, gate table, config sketch, and rollout live in
[`docs/superpowers/specs/2026-07-14-per-issue-quality-gates-design.md`](../superpowers/specs/2026-07-14-per-issue-quality-gates-design.md).

## Decision

Adopt seven gates, split by **when they are assessable**, and rolled out **shadow-first**.

### Pre-dispatch gates (ship now as `GATES` entries; concern the plan/approach)

| Gate | Tier | Authority |
|---|---|---|
| `value-clear` | always | **operator** |
| `spec-present` | always (with `mechanical` opt-out) | agent |
| `alternatives-considered` | nontrivial | agent |
| `arch-fit` | nontrivial | **operator** |

### Delivery gates (specified now; enforce-able as DAG nodes on #17; concern the change)

| Gate | Tier | Authority |
|---|---|---|
| `tests-pass` | always | sensor (CI, the #12 sensor) |
| `code-review` | decision-bearing | agent (a **different model** than the implementer) |
| `docs-updated` | user-facing | agent |

### Authority scheme

**Agent-certifies; the operator stamps only `value-clear` and `arch-fit`** — applying
ADR 0002's principle that the operator stamps only what is genuinely not the agent's to give.
What is valuable, and whether a change fits the architecture, are operator judgments;
everything else an agent certifies or a command decides. tiller cannot verify the
"different model" property of `code-review` from its fact log — that is a **process rule** in
this ADR and the review skill, not a machine check.

### appliesWhen scheme (two-tier)

A **universal core** binds on every delivery goal: `value-clear`, `spec-present`,
`tests-pass`. **Situational extras** bind on a single label (`gateApplies` matches one
`labelsInclude`): `nontrivial` → `alternatives-considered` + `arch-fit`; `decision-bearing` →
`code-review`; `user-facing` → `docs-updated`. Because the core always binds, a forgotten
situational label can only *under*-gate down to the core — never leave an issue ungated.

### Rollout

All new gates start `mode: 'shadow'` and graduate to `enforce` one at a time on their own
divergence record (ADR 0001 axis 5 / ADR 0002 axis 3), so the current open issues are not
retroactively frozen. This ADR is prose — consistent with ADR 0002's rejection of speccing
the *process* itself in allium.

## Consequences

- The four pre-dispatch gates are added to `tiller.config.mjs` `GATES` (shadow), and three
  labels (`nontrivial`, `decision-bearing`, `user-facing`) are created. No engine code
  changes.
- The three delivery gates are the contributor merge bar today (CI + the review/docs
  discipline) and become enforce-able only when **#17** lands the DAG; a pointer is recorded
  on #17. `tests-pass`'s mechanical verdict rides the **#12** CI-sensor.
- `spec-present` binds universally with a `mechanical` opt-out honoring ADR 0002's plumbing
  carve-out. During shadow the opt-out is a process convention (the operator ignores the
  would-park for `mechanical` issues); its enforce-graduation must pick a concrete mechanism.
- The engine-default `spec-check-clean` sensor gate is **not** in `tiller.config.mjs`;
  `spec-present` (agent) subsumes "checks clean" for now. Porting the sensor as a mechanical
  adjunct is an optional follow-up. **(Resolved 2026-07-16 — see Update below.)**

## Update (2026-07-16) — spec-check-clean ported; a brief enforce experiment reverted on a ripeness-gate deadlock

The optional follow-up is taken. `tiller.config.mjs` now carries the `spec-check-clean` gate
(`authority: 'sensor'`, `appliesWhen` a cited `spec/*.allium` path) backed by a `spec-check`
`kind: 'allium'` sensor (`allium check` + `analyse`, `failOn: ['error','warning']`) — the
mechanical other half of `spec-present`'s coverage judgement. Two gates now express the request
"each issue has a spec covering the changes, checking clean": `spec-present` (agent — coverage)
and `spec-check-clean` (sensor — cleanliness of cited specs).

Both were briefly set to `mode: 'enforce'` at operator request, then **reverted to `shadow` the
same day** on a demonstrated deadlock. As a *ripeness* (pre-dispatch) gate, `spec-check-clean`
parks any issue citing a spec that carries warnings — **including the issue whose own deliverable
is that spec**. Observed live: **#14** (retire `goal-liveness.allium`'s stale header), **#20**
(spec fidelity for it), and **#17** all park on `goal-liveness.allium`'s two *documentary-
declaration* warnings (`entity Fact`, `enum AbsenceSentinel` — deliberately-declared substrate/
concept names the linter flags as unused). The sting: **#17 is the very issue that would make
clean-check a proper delivery gate**, and the ripeness gate parked it. Meanwhile `spec-present`
at enforce parks every delivery goal lacking an agent certification, and tiller dispatches
nothing yet — so no stream *produces* that certification. Net: with both enforced, **no
remediation issue could come ripe** without an operator hand-editing the spec or attesting,
outside the loop. tiller's per-goal wedge audit did not flag it (each park's unpark — "the spec
becomes clean" — is individually producible), so the loop looked live while globally stuck behind
a blocked producer.

This is exactly ADR 0003's own reasoning for `tests-pass`: a mechanical check over the
**delivered artifact** deadlocks as a ripeness gate. Resolution: both gates stay **`shadow`** —
they surface the warnings and missing-spec signals in every snapshot (visible, attention-driving)
without blocking the fix. The enforce-able forms are tracked where they cannot deadlock:
`spec-check-clean` as a **delivery/merge DAG node on #17** (blocks merge, not dispatch), and
`spec-present`'s enforce **gated on a cert-producing conditioning stream** (there is none while
tiller is read-only). The lesson generalises: *the enforce-able form of a mechanical
delivered-artifact check is a delivery gate, never a pre-dispatch ripeness gate.*

## Alternatives considered

- **Operator stamps every judgment gate** (value, alternatives, spec, review, docs, arch).
  Rejected: the most stamping — exactly the ceremony ADR 0002 shed — for assurance an agent
  can credibly provide on all but value and architecture.
- **Uniform gate set on every issue** (all seven on `{ goalType: 'delivery' }`). Rejected:
  over-applies (a typo-fix would carry alternatives-considered + cross-model review); the
  two-tier core + situational-extras is the minimal-per-issue reading.
- **Model all seven as `GATES` entries now.** Rejected: the delivery gates deadlock as
  ripeness gates on today's engine; they need the #17 DAG to merge-gate.
- **Spec the workflow in allium.** Rejected, per ADR 0002 — machine-checking the process
  re-imports the ceremony tiller is shedding; a prose ADR is the right weight.

## Follow-ups

- Add the four pre-dispatch gates to `tiller.config.mjs`; create the three labels; regenerate
  the README Workflows section (`node src/diagram.mjs --write`) so the diagram-drift gate
  stays green.
- Graduate the shadow gates (`value-clear`, `spec-present`, `alternatives-considered`,
  `arch-fit`) to enforce individually on their divergence record. **All remain shadow** — the
  2026-07-16 enforce experiment on `spec-present` + `spec-check-clean` was reverted the same day
  (see Update). At `spec-present`'s enforcement the `mechanical` opt-out needs a concrete machine
  mechanism, AND a stream must *produce* the agent certification (tiller dispatches nothing yet).
- Author the three delivery gates as DAG nodes when #17 lands (`reviewed` / `verified` the
  first delivery nodes, per ADR 0001). **`spec-check-clean`'s enforce-able form joins them here**
  as a delivery/merge node — a mechanical delivered-artifact check deadlocks as a ripeness gate,
  so its enforcing home is the DAG, not `GATES` (see Update).
- ~~Optionally port the engine-default `spec-check-clean` sensor gate into `tiller.config.mjs`.~~
  **Done 2026-07-16** (see Update) — ported at `mode: 'shadow'`.
- **File a shaped issue** to resolve `goal-liveness.allium`'s two documentary-declaration
  warnings (`entity Fact`, `enum AbsenceSentinel`) — a spec-modelling judgement (reference /
  annotate-intentional / accept), unblocking the shadow `spec-check-clean` signal on #14/#17/#20.
