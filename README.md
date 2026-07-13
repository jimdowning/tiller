# Tiller — coordination engine (preliminary)

The derived-plan/fact-log engine, built from the validated seeds of experiments
E0–E6 (SYNTHESIS.md, both gates passed): E2's fuzz-validated
total classifier, E1's fold + templates, E4's thin verifier, E3's hysteresis
knobs, E6's read-only sensing. Hand-rolled JS per the E5 fork verdict. Zero
dependencies; tests run on `node --test`.

**Origin.** This repo was extracted (history-preserving) from
[jimdowning/strengthsys](https://github.com/jimdowning/strengthsys), where the
engine grew up at `design/coordination-model/engine/`. The experiments E0–E6,
their corpus, and `SYNTHESIS.md` are evidence about strengthsys's outer loop
and stay there: see
[design/coordination-model](https://github.com/jimdowning/strengthsys/tree/main/design/coordination-model).

```
node src/tick.mjs                # one live reconciliation tick (read-only fetch)
node src/tick.mjs --offline      # re-derive from the stored fact log only
node src/explain.mjs 419         # why isn't #419 ripe, and what exactly clears it
node src/attest.mjs 10 journey-articulation pass   # operator verdict stamp
node --test 'test/*.test.mjs'    # 81 tests
node test/fuzz.mjs               # classifier property fuzzer (12k seeds — the CI gate)
node scripts/check-spec.mjs      # allium check/analyse on the contract spec
```

CI (`.github/workflows/ci.yml`) runs all three gates — tests, fuzz, spec —
on every push and PR.

## Self-hosting (tiller-on-tiller)

This repo dogfoods its own engine (#1): `tiller.config.mjs` at the root is a
consumer-shaped config sensing `jimdowning/tiller` itself, run from the repo
root:

```
TILLER_CONFIG=./tiller.config.mjs node src/tick.mjs
```

State lands in `.tiller/state/` (gitignored), snapshots in
`.tiller/snapshots/` (committed). Development here runs a **thin delivery
template** — the per-repo override introduced for exactly this purpose:

- stages `shaped → ripe → pr-open → merged`; the whole ripeness contract is
  one `shaped` label. No blast-radius taxonomy, no reversibility label, no
  ceremony floor (a config's `DELIVERY_TEMPLATE` export replaces the engine
  default in `src/templates.mjs`; consumers that don't override keep the
  heavyweight contract unchanged).
- changes land as commits straight to `main` (no PRs unless contested);
  fast-forward pushes only, so pinned SHAs stay reachable.
- two day-one situational gates (shadow mode) bind on goals touching the
  classifier/fold: `classifier-fuzz` (a passing `fuzz-run` verdict from the
  command sensor — `node test/fuzz.mjs`, input-hash keyed on
  `src/classify.mjs` + `src/schema.mjs` + the fuzzer) and
  `classifier-spec-sync` (the `spec/goal-liveness.allium` update, attested by
  the **operator** via `attest.mjs` — an agent-sourced pass does not satisfy
  it).

## Consumer pin-bump gate (strengthsys)

Strengthsys is insulated by its submodule pin: nothing here affects its
coordination until a deliberate, reviewed pin bump. A pin-bump PR **must
include an offline snapshot diff** — run `tick.mjs --offline` over the
consumer's stored fact log under the old and the new engine, and diff the
buckets:

```
# in the consumer repo, once per engine version (state copied so the real
# hysteresis/snapshots are untouched):
cp -r .tiller/state /tmp/pin-diff-state
TILLER_CONFIG=/tmp/pin-diff.config.mjs node <old-engine>/src/tick.mjs --offline
TILLER_CONFIG=/tmp/pin-diff.config.mjs node <new-engine>/src/tick.mjs --offline
# diff the two snapshot .json files: bucket counts + per-goal membership
```

Bucket changes on real historical facts are exactly what the bump review
reads: an intended semantic change shows up as an explainable membership
diff; an unintended one is a regression caught before the pin lands.

## Configuration — `TILLER_CONFIG`

By default the engine reads `engine.config.mjs` next to `src/` and keeps its
state (`state/`) and snapshots (`snapshots/`) inside the engine directory —
exactly the historical in-tree behaviour, so the commands above work from a
bare checkout.

To run the engine against a target repo (e.g. as a submodule), set
`TILLER_CONFIG` to the path of a config `.mjs` in that repo:

```
TILLER_CONFIG=./tiller.config.mjs node tiller/src/tick.mjs
```

A **relative** `TILLER_CONFIG` resolves against the *invoking* cwd — the
first of `INIT_CWD` (npm/pnpm scripts), `PWD` (the shell's cwd, inherited
unchanged through spawn), then the process cwd where the file actually
exists — never silently against the engine directory, so callers that spawn
the engine with `cwd` set to the engine dir still get the config they named
(#5). If the file exists under none of those bases, config loading fails
loudly listing what was tried; pass an absolute path to be fully explicit.

The config module exports what `engine.config.mjs` exports (`GATES`,
`SENSORS`) plus optional path settings, each resolved **relative to the
config file's directory** (so a config at the target repo's root is robust to
the caller's cwd):

- `stateDir` — fact log, hysteresis memory, meta cache (machine-local;
  gitignore it)
- `snapshotDir` — derived-plan snapshots `<date>.{json,md}` (date-named →
  conflict-free; commit them)
- `repoRoot` — the sensed repo's root, used by mechanical sensors such as
  spec-check (default: the config file's directory)

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
hysteresis.mjs           — E3's I4 gate (W=3 K=3 M=1.0 cw=2), ASYMMETRIC: a
   │                       goal's FIRST ripening dispatches immediately;
   │                       committed ripeness survives one-tick flickers; only
   ▼                       a goal that has de-committed once holds-open (W/K) on
   │                       re-ripening (operator 2026-07-11 — see file header)
tick.mjs                 — orchestration + snapshots/<date>.{json,md}
```

Facts and buckets follow [`spec/goal-liveness.allium`](spec/goal-liveness.allium) —
the classifier contract, vendored from the E2 experiment artifact
([original](https://github.com/jimdowning/strengthsys/blob/main/design/coordination-model/experiments/e2-liveness/goal-liveness.allium),
in strengthsys) and now the living contract for this repo: a classifier/fold
change is expected to update it (the `classifier-spec-sync` gate).

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

- **Degraded senses fail loudly, never clobber.** GitHub search can return a
  partial result set with `incomplete_results: true` and no error; sensing
  treats that (and a pagination-truncated set, and an implausibly shrunken
  open set vs the previous `state/meta.json` — default: shrink below 50% of
  a previous count ≥ 5) as a `DegradedSenseError` that aborts the tick
  *before* any fact append, descope contradiction, or meta write (#4). The
  append-only fact log would survive a bogus small sense by design; `meta`
  would not. A genuine mass-close is accepted explicitly with
  `--accept-shrink`.
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
- **Date gates keep "not yet time" out of `ripe`** (`parked(date-gate)`, #11).
  A body line `earliest-start: YYYY-MM-DD` or a `gated-until:YYYY-MM-DD` label
  parks an otherwise-ripe goal until the *tick date* reaches it, then clears
  itself — no operator action — via a manufactured `date-reached` fact. This
  separates "not yet time" (a legitimate wait on a date) from "not yet
  understood" (unconditioned), so a conditioned-but-embargoed goal need not be
  left unconditioned to stay undispatched. The comparison uses the injected
  tick date, so ticks stay deterministic/replayable; editing the marker
  re-derives the gate on the next tick.
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

Each limitation below is a tracked goal in this repo's own backlog — the
self-hosted instance senses them (#7–#10).

- Sensing ingests issue timelines, comments, and bodies — not PR reviews, CI
  `workflow_run` conclusions, or repo-file predicates (the SYNTHESIS §2
  widening order). The `verified` stage of the delivery template is therefore
  not yet derivable. (#7)
- `heartbeat` facts are modelled (classifier + schema) but nothing emits them
  yet; wiring /loop-wrapped streams to append heartbeats is the dead-loop
  detector (E0-07) and comes with the entry skills. (#8)
- Stage reporting beyond `conditioned`/`pr#N[-merged]` is thin; the template
  registry exists (and is per-repo overridable) but only gates ripeness via
  the label contract. (#9)
- Hysteresis is **asymmetric** (operator 2026-07-11): a *newly seen* ripe goal
  dispatches immediately (no hold-open), because premature ripening had never
  occurred (0 down-flickers over the first live ticks) while the ~W-tick
  dispatch latency was a real cost. The W/K hold-open is retained only for
  *re*-ripening after a de-commit (a goal that has proven flicker-prone), and
  the M/cw down-side damping is unchanged. Reinstate first-commit hold-open
  (one-line: drop the `!hasCommitted` fast path in `hysteresis.mjs`) or run
  `--no-hysteresis` if churn from the LLM-judge signal starts to bite.
- The dispatcher/entry skills (`/achieve`, `/po-todo` readers) are not built;
  the engine produces the derived plan (snapshot), it does not yet dispatch.
- Decomposition *edges* are facts, but the decomposition *act* is not — so
  nothing in the fold triggers re-decomposition when a journey's scope is
  invalidated (spec ramifications, product escalations, child drift), and
  the waste-in-the-large metrics (stale-dispatch exposure in human minutes /
  LLM tokens / compute minutes) are not yet derivable. Agreed design:
  [`decomposition-freshness.md`](https://github.com/jimdowning/strengthsys/blob/main/design/coordination-model/decomposition-freshness.md)
  (in strengthsys) — a `decomposition-verdict` fact
  (input-hash keyed, superseding) with a `needs-decomposition` park, the
  gate pattern applied one level up. (#10)
