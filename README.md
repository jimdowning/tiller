# Tiller — coordination engine (preliminary)

The derived-plan/fact-log engine, built from the validated seeds of experiments
E0–E6 (`../experiments/SYNTHESIS.md`, both gates passed): E2's fuzz-validated
total classifier, E1's fold + templates, E4's thin verifier, E3's hysteresis
knobs, E6's read-only sensing. Hand-rolled JS per the E5 fork verdict. Zero
dependencies; tests run on `node --test`.

```
node src/tick.mjs                # one live reconciliation tick (read-only fetch)
node src/tick.mjs --offline      # re-derive from the stored fact log only
node src/explain.mjs 419         # why isn't #419 ripe, and what exactly clears it
node src/attest.mjs 10 journey-articulation pass   # operator verdict stamp
node --test 'test/*.test.mjs'    # 50 tests
```

## Issues-only state model

**The engine reads no milestones.** Milestone MCP tooling is restricted (web
containers can't do useful milestone work), and every job milestones did maps
onto plain-issue constructs the engine senses with ordinary issue APIs:

| milestone construct | issues-only replacement |
|---|---|
| membership (issue ∈ milestone) | journey issue (`goal:journey` label) whose body task-list (`- [ ] #N`) declares children; or `Part of #N` in the child body |
| `[CURRENT]` / `[NEXT]` name markers | `focus:current` / `focus:next` labels on the journey issue |
| "PO todo" milestone | `po-todo` label |
| completion counting (all closed?) | derived: a journey `waiting` on its children ripens when all are done — its ripeness IS the transition decision surfacing. No self-count deadlock is expressible (E0-11) |

Membership must be *declared* (task-list or Part-of line), not implied — a
declared edge is a fact; milestone membership was always a side-channel.
Deleting a task-list line descopes the child (a `contradiction` fact retires
the edge; `descopeContradictions`).

## Architecture

```
GitHub (read-only)                          state/facts.jsonl (append-only)
   │  sense/github.mjs   — fetch open set, timelines, comments, BODIES
   ▼
sense/translate.mjs      — ALL lexical heuristics live here (E5: sensing is
   │                       irreducibly imperative). Stateless re-derivation:
   │                       event-derived facts carry event timestamps, so
   ▼                       re-sensing dedups to a no-op (idempotent ticks).
store.mjs                — content/logical dedup, never modify, never delete
   ▼
classify.mjs             — PURE total fold: every formed goal in exactly one
   │                       bucket (ripe | parked | waiting | done). Multi-park
   │                       (a goal carries ALL its blockers), generic unpark
   │                       firing, cycle parking, I1 contradictions, I3
   ▼                       liveness (timeout-repair of dead unpark predicates)
verify.mjs               — E4's thin verifier over ripe candidates: operator-
   │                       gated / approach-fork / hard-dep-on-open + route
   ▼                       floor annotation. Fails park body-keyed → an edited
   │                       body re-observes and re-verifies automatically.
hysteresis.mjs           — E3's I4 gate (W=3 K=3 M=1.0 cw=2): raw-ripe goals
   │                       hold-open ~W ticks before dispatch; committed
   ▼                       ripeness survives one-tick flickers
tick.mjs                 — orchestration + snapshots/<date>.{json,md}
```

Facts and buckets follow `../experiments/e2-liveness/goal-liveness.allium`.

## Situational gates (shadow-first)

`engine.config.mjs` declares gates as `(situation predicate) → required
validity verdict`. A gate binds only in the situations that make its prework
necessary (never universally), starts in **shadow mode** (the tick reports
what *would* park; nothing blocks), and graduates to enforce individually on
its divergence record — event-counted, not wall-clock. Two live examples:

- `spec-check-clean` (easy end, `authority: sensor`): goals whose body cites a
  `spec/*.allium` file require a passing `allium check` + `analyse` verdict.
  The sensor keys verdicts by input hash — unchanged specs never re-run; a
  spec edit supersedes by fold order. A *failing* verdict never unparks
  (`disjunctFires` requires `verdict: pass`).
- `journey-articulation` (hard end, `authority: operator`): `goal:journey`
  goals require a journey/value verdict whose fact carries
  `source: 'operator'` — an agent may run the challenge/refinement
  conversation, but the stamp is recorded only via `attest.mjs`. An
  agent-sourced pass does not satisfy the gate.

First shadow datapoint (2026-07-05): **55/55 spec-citing goals would park** —
every current spec carries warnings. Enforcing on day one would have frozen
the backlog; the `failOn` threshold (warnings vs errors-only vs a
no-new-warnings ratchet) is an open operator calibration.

## Semantics worth knowing

- **Multi-park.** A goal holds a *set* of parks keyed by reason
  (unconditioned AND operator-parked coexist). It ripens only when every park
  clears. First live tick against this repo caught the single-slot loss.
- **Unpark disjuncts can be qualified**: `artifact-produced:conditioned`
  fires only on the conditioning grant (the operator stamp via the label
  contract, per #572 doctrine) — a PR artifact does not unpark
  `needs-conditioning`.
- **`operator-response` is scarce.** Sensing emits it only against an
  outstanding operator park (or on removing the last operator label, or a
  `startable: yes` derisking verdict). Routine `**FYI**` comments are noise —
  emitting per-FYI silently unparked four goals on the first live tick.
- **Timeouts surface, never resolve.** A park past its TTL
  (`TIMEOUT_TTL_DAYS`) gets a manufactured `timeout` fact that marks it
  **overdue** (the snapshot's Attention section → /po-todo feed). It never
  clears the park — a silent self-release would recreate the E0-04 class.
- **Untracked dependencies park** (`parked(untracked-dependency)`, the E6
  #419 correction) with a producible unpark: a tracking issue appearing
  (`dependency-declared`), a derisking reversal, or the timeout surfacing.
- **Externals**: refs pointing outside the open set are resolved read-only so
  a closed dependency reads as done, not absent. Unresolvable refs stay
  blocking — the safe, re-checkable default.

## First live tick (2026-07-05)

131 open issues → 671 facts: ripe 0, holding 2 (#122, #179 — exactly E6's
ripe set, held by the hold-open gate for W=3 ticks), parked 120, wedges 0.
#122 was closed by the operator *mid-tick* and the external-resolution path
tracked it to `done` within the same run. #419 shows both real blockers
(`needs-conditioning` + `untracked-dependency`), the stale one surfaced
overdue.

## Honest limitations (preliminary)

- Sensing ingests issue timelines, comments, and bodies — not PR reviews, CI
  `workflow_run` conclusions, or repo-file predicates (the SYNTHESIS §2
  widening order). The `verified` stage of the delivery template is therefore
  not yet derivable.
- `heartbeat` facts are modelled (classifier + schema) but nothing emits them
  yet; wiring /loop-wrapped streams to append heartbeats is the dead-loop
  detector (E0-07) and comes with the entry skills.
- Stage reporting beyond `conditioned`/`pr#N[-merged]` is thin; the template
  registry exists but only gates ripeness via conditioning.
- Hysteresis holds a *newly seen* ripe goal for W ticks (day-one E3 knobs,
  deliberately small). If dispatch latency matters more than anti-thrash
  early on, run `--no-hysteresis` and calibrate against real churn.
- The dispatcher/entry skills (`/achieve`, `/po-todo` readers) are not built;
  the engine produces the derived plan (snapshot), it does not yet dispatch.
- Decomposition *edges* are facts, but the decomposition *act* is not — so
  nothing in the fold triggers re-decomposition when a journey's scope is
  invalidated (spec ramifications, product escalations, child drift), and
  the waste-in-the-large metrics (stale-dispatch exposure in human minutes /
  LLM tokens / compute minutes) are not yet derivable. Agreed design:
  `../decomposition-freshness.md` — a `decomposition-verdict` fact
  (input-hash keyed, superseding) with a `needs-decomposition` park, the
  gate pattern applied one level up.
