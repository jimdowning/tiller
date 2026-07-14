---
adr: 0002
title: development-workflow-thin-allium-contract-first
status: accepted
date: 2026-07-14
supersedes: []
superseded_by: null
---

# ADR 0002: Tiller's development workflow — thin, contract-first, allium at the center

## Context

Tiller was extracted (history-preserving) from strengthsys to develop under its own,
much lighter process (#1). After the first self-developed change shipped (#9, stage
reporting), the workflow that carried it was mostly **inherited from the README's thin
template rather than deliberately chosen**: pick a `shaped` issue → read spec + code +
tests → green baseline (`node --test` + `fuzz` + `allium check`) → implement → tests →
re-run gates → dogfood a self-tick → commit direct-to-main, FF-push → close. The only
allium touchpoint was *reading* `goal-liveness.allium`; no spec was written, because #9
was reporting-only and never bound the `classifier-spec-sync` gate.

This ADR makes that workflow deliberate. It is the **contributor** workflow — how a
change to tiller *itself* is made — and is distinct from ADR 0001's **development
template** (the capability-typed DAG the engine dispatches *sensed issues* along). The
two meet only at dogfooding: tiller's own issues flow along tiller's own template.

**Why not copy strengthsys.** Strengthsys's ceremony — architect + implementor team,
the full reviewer slate, the conditioning contract, `/implement-feature` — exists to
(a) coordinate multiple concurrent agents and (b) manage product risk for real users.
Tiller has neither: it is solo-developed, zero-dependency, and its only consumer
(strengthsys) is insulated behind a deliberately-reviewed submodule pin. What tiller
*does* have is that **its entire value is behavioral correctness** — liveness,
determinism, fold purity. So the right trade is to drop the coordination/product
ceremony wholesale and instead **keep and sharpen the correctness discipline**. Allium
is the medium for that: the classifier already demonstrated that a spec + property fuzz
catches liveness bugs that example tests miss.

## Decision

Adopt a **thin, contract-first** workflow in which allium's behavioral contracts cover
the **whole engine** (operator decision, 2026-07-14). Five axes; like ADR 0001, fix the
discipline now and grow the spec tree empirically as changes touch each subsystem.

### 1. Contract-first for behavior, code-first for plumbing

The discriminator is **semantics, not size**:

- A change is **behavior-defining** if it alters what buckets / unparks / stages / gates
  / senses *mean*. The allium spec is authoritative and is updated **first**
  (`allium:tend`); tests are derived from its obligations (`allium:propagate`); the
  implementation is written to make them pass.
- A change is **mechanical** (snapshot rendering, config resolution, sensor I/O, pure
  refactors) → code + example tests, **no spec**.

### 2. Whole-engine behavioral coverage, incrementally

Every subsystem's **behavioral contract** gets an allium spec — classifier
(`goal-liveness.allium`, existing), sensing determinism (`sense/translate.mjs`), the
verifier, hysteresis, stage projection, and the ADR-0001 template DAG. **Plumbing stays
uncovered by design.** The tree is built incrementally as changes reach each subsystem,
never as a big-bang spec-a-thon. `goal-liveness.allium` is promoted from its stale
"EXPERIMENT ARTIFACT — NOT authoritative" header to the living contract it already is,
and relocated into a proper `spec/` tree as the second spec lands.

### 3. Situational spec-sync gates, shadow-first

Generalize the existing `classifier-spec-sync` gate: each subsystem spec gets a
situational `*-spec-sync` gate that **binds only when a change cites that subsystem's
code paths** (`appliesWhen: { bodyCites }`), requiring the spec update. The sync stamp is
**operator-authority** (an agent-sourced pass does not satisfy it), as today. New gates
start in **`mode: 'shadow'`** — they report what they *would* park and block nothing —
and graduate to `enforce` one at a time on their own divergence record. This reuses
ADR 0001 axis 5 (new topology observable before it is binding) and keeps a fresh spec
from freezing the backlog on day one.

### 4. Three authority classes, reused

`sensor` (a command / CI run decides), `agent` (produces an artifact for another to
judge), `operator` (a human stamp) — the one attestation model already in the engine and
ADR 0001. `allium:propagate` and `allium:weed` run under **sensor** authority
(mechanical, input-hash keyed); the `*-spec-sync` stamps are **operator** authority.

### 5. Solo, direct-to-main, gate-driven delivery

No team, no reviewer slate, no conditioning contract — ripeness is one `shaped` label
(the thin template). The bar is the gates: `node --test` + `fuzz` + `allium check`, plus
`allium:weed` for spec↔code drift (pre-merge, or on a cadence). Changes land as **commits
straight to `main`, fast-forward only**, so pinned SHAs stay reachable. A **PR is opened
only for a decision-bearing change** — the durable pre-merge set `{architectural,
irreversible, cost}` + UI (ADR 0001) — never routinely. **Dogfood is the acceptance
readout**: shape the issue, run a self-tick, confirm the engine sensed the change (ripe →
the artifact/stage it produced); the snapshot is committed evidence.

## Consequences

- Allium stops being classifier-only and becomes the engine-wide **correctness medium**.
  The dev loop is `tend → propagate → implement → weed`, wrapped in the three gates.
- **#9 shipped code-first**; retroactively it wants a stage-projection spec (stages are
  reporting-only per ADR 0001, so it is a *separate* projection spec, not part of the
  liveness contract). Filed as a follow-up — under this ADR's rule it would have been
  speced first.
- The seed backlog's **item 4** (skill bootstrap: `propagate` / `weed` / `/verify` /
  `skill-creator`) is now the **on-ramp** for this workflow, not an afterthought on #1.
- `goal-liveness.allium`'s "NOT authoritative" disclaimer is retired.
- **Cost stays bounded.** Plumbing — the bulk of edits — skips specs entirely; only
  semantic changes pay the spec tax, and shadow-first gates keep new coverage from
  blocking before it has earned enforcement.

## Alternatives considered

- **Copy strengthsys's team ceremony.** Rejected: it coordinates a team and manages
  product risk tiller does not have; pure overhead here.
- **Code-first everywhere (tests only, no specs).** Rejected: tiller's value *is* its
  behavioral contracts; leaving them implicit in code is exactly the drift allium exists
  to prevent, and the classifier already proved spec + fuzz catches liveness bugs example
  tests miss.
- **Spec the workflow itself in allium (`spec/process.allium`).** Rejected for now:
  machine-checking the *process* re-imports the ceremony tiller is shedding; a prose ADR
  is the right weight. Revisit only if the workflow grows contested, machine-enforceable
  rules.
- **Spec-after / distill periodically.** Rejected as the default: distillation lags
  reality and forgoes the spec-first design benefit. `allium:distill` stays a tool for
  onboarding un-speced legacy areas, not the loop.

## Follow-ups

- Promote + relocate `goal-liveness.allium` into an authoritative `spec/` tree as the
  second spec lands.
- Author per-subsystem behavioral specs incrementally: sensing determinism, the verifier,
  hysteresis, stage projection (retroactive for #9), the template DAG (ADR 0001 axis 1).
- Add each subsystem's situational `*-spec-sync` gate in shadow when its spec lands.
- Deliver #1 item 4 as the on-ramp: `allium:propagate` (tests from `goal-liveness`),
  `allium:weed` (drift check), the `/verify` bootstrap, `skill-creator` minimal skills.
- File a journey issue tracking whole-engine allium adoption with these as children.
