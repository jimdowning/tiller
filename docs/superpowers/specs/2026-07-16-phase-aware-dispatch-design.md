# Design: phase-aware / capability-matched dispatch

**Date:** 2026-07-16
**Status:** design (brainstorm) — engine work gated on #17 (ADR 0001 substrate)
**Scope:** `jimdowning/tiller` (this repo). Lands direct-to-main, FF-push, per repo convention.
**Tracks:** #21 (split from #13). Depends on #17, [ADR 0001](../../adr/0001-development-template-dag-substrate.md).

## Problem

One issue does not move through the world as a single unit of work. A UI feature is
*clarified*, then a mockup is *drafted* and *approved*, then it is *implemented*, then
*reviewed*. Each of those is a different **work-type** needing a different **execution
environment** — an operator to approve a mockup, an autonomous sandbox to write tests, an
interactive session to run a simulator. tiller#13 named the missing capability *"phase-aware
dispatch"*: one issue becomes ripe *for the current phase's work-type*, something decides
"what's next for this ticket", and it re-ripens for the next phase.

[ADR 0001](../../adr/0001-development-template-dag-substrate.md) already decided the
**substrate** for this — stages generalize to a capability-typed DAG, node position is
*derived* not stored, and "the frontier is a set" (axis 3). #17 implements that substrate.
This design covers the **other half** ADR 0001 left as an explicit follow-up:

> Build capability-matched dispatch: the matcher + a session-capability registry (session
> attributes ⊇ node requirements). Separate from this substrate — tiller currently dispatches
> nothing.

That follow-up is written as if dispatch is greenfield. **It is not** — which is the first
thing this design corrects.

## What already exists: `next.mjs` is a per-goal matcher

`src/next.mjs` is a working capability-matched selector, and strengthsys's `pnpm
dispatch:next` was repointed onto it (strengthsys#597 — `dispatch-next.sh` reads
`next.mjs --pick`). The tiller docs are careful here and stay correct: *"`next.mjs` matches
a session to work, but tiller itself dispatches nothing"* (`docs/architecture.md`) — the
engine *selects*; the coordinating system *acts*. The point for this design is not that the
docs are wrong but that the **matcher already exists and is live-wired**, so ADR 0001's
follow-up phrase *"tiller currently dispatches nothing"* — literally true of the engine's
*action* — must not be read as "there is no matcher to build on." Phase-aware dispatch
**generalizes `next.mjs`**; it is not greenfield.

Today's matcher works at the **goal** grain:

- `match()` iterates the classification (one row per goal), keeps `bucket === 'ripe'`, drops
  journeys and `claimed-by:*`, honours the hysteresis gate, then compares `requirementsOf(goal)`
  against an ask-time probed capability set.
- `requirementsOf(c, m)` derives requirements **per goal**, three provenances: `declared`
  (`needs:<cap>` labels), `derived` (`routeFloor === 'fullteam'` → `interactive`), `learned`
  (a `capability:<name>` park appended after a session hit a missing tool mid-flight).
- `probeCapabilities()` probes the *current* environment fresh at ask time (`node/pnpm/docker/
  gh/allium` + derived `build-stack`/`interactive`) — deliberately never trusting stale global
  state, because "sessions die without revoking."
- The output work-type is **implicitly always implementation**. The one alternative projection
  is `--as operator` (parked goals + outstanding operator-authority gate verdicts).

So `next.mjs` is a *linear-template* cut of the ADR 0001 matcher. Phase-aware dispatch is its
generalization onto the DAG substrate.

## The seam that must not move

Every source in the corpus states the same boundary, and this design keeps it:

- **The fold stays pure and capability-agnostic.** `spec/goal-liveness.allium` excludes "the
  scheduler — capability match, priority, leases, WIP, back-pressure"; `docs/concepts.md`:
  "keeping session availability, scheduling, and capability-matching out of the classifier is
  deliberate — the moment those leak in, the plan stops being deterministic." `classify.mjs`
  folds `capability-asserted/revoked` into a `caps` set but **never reads it in bucket logic**.
  ADR 0001 axis 3 rejected a capability-aware classifier outright: *"Scarcity belongs in
  dispatch."*
- **Selection is a match, not a queue.** The session presents its set; it takes the highest-
  priority node it can serve, skipping ones it cannot. No stored per-issue phase field.
- **Lane-local policy stays in the wrapper.** The live `claimed-by:*` re-check under `flock`
  and the `reversibility:hard → plan-approved` gate are `dispatch-next.sh`'s, not the engine's.

Everything below lives in `next.mjs` (or a sibling projection), never the classifier.

## Design

### 1. Match at the node, not the goal

`match()` currently yields one row per ripe *goal*. On the #17 substrate it must yield one row
per ripe **node** of each goal's matched subgraph — the *frontier as a set*. A single issue
with `spec-resolved ∥ mockup-approved` both ripe contributes **two** rows, each a different
phase, each independently matchable and skippable. The row grows a `node`/`phase` field and a
`workType` field (below). Journey handling, `claimed-by:*` drop, and the hysteresis gate are
unchanged — they gate the *goal*, and a claimed goal contributes no dispatchable nodes.

**Contract-first (ADR 0002):** this touches the matcher's contract, so the node/predecessor +
profile schema is formalized in `spec/goal-liveness.allium` first (the ADR 0001 follow-up), and
the situational `*-spec-sync` gate for `src/next.mjs` lands in **shadow** with the code.

### 2. Requirements come from the node's profile

`requirementsOf` today reads goal-level labels/routeFloor/parks. It generalizes to read the
**node's execution-environment profile** — ADR 0001 axis 2's *open attribute bag*
(operator-presence, model tier, harness tooling, sandbox posture; non-interactive-executability
*derived* from sandbox posture + operator-presence). The three existing provenances do not
disappear; they become **inputs to a node's profile**, not the whole requirement:

- `declared` `needs:<cap>` labels still contribute (now scoped to the node whose `appliesWhen`
  matches, not the whole goal).
- `derived` `routeFloor` becomes one attribute among several, not the sole interactive trigger.
- `learned` capability parks still sharpen a node's profile after a real miss.

**Design caution from E4:** the routing floor "is a *safe lower bound*, not a classifier — its
errors are all over-provisioning." So a node's derived profile is a **minimum** required set;
a session whose attributes strictly exceed it still matches. And E4's *"only #172 carried
`blast-radius`/`reversibility` at conditioning — labels aren't a reliable decision-time
signal"* argues the profile must not lean solely on conditioning-time labels; body-cited
signals and node-type defaults carry it where labels are absent.

### 3. Phase → work-type routing

A matched row carries **which kind of work** the node is, so the dispatch wrapper routes it to
the matching session-kind / skill rather than a blanket implementor. The coarse version already
exists — ADR 0001's three authority classes (`sensor` / `agent` / `operator`) — and `next.mjs`
already projects the `operator` slice via `--as operator`. Phase-aware routing adds a finer
`workType` tag *within* the `agent` class (`draft-mockup` vs `implement` vs `review`), because
those are different skills on different profiles.

**Recommendation:** `workType` is a **node attribute** (declared on the template node), not
derived from labels — the template is the single place the canonical DAG's shape lives, and a
node already declares its authority class and `appliesWhen`. The router is then a thin map from
`workType` → dispatch target, owned by the *wrapper* (the same layer that owns lane-local
policy), keeping the engine's job "here is the ripe node and its work-type", not "here is the
skill to run." This preserves the wrapper/engine split strengthsys#597 established.

### 4. Session-capability registry vs ask-time probe

`probeCapabilities()` answers "what am I right now." Bottleneck batching needs the matcher to
reason about profiles it does **not** currently embody ("these N nodes are all queued on a
scarce mobile-simulator session"). That wants a **declared registry** of session profiles.

**Recommendation:** keep ask-time probe as the **trust-root for what a session may take** (the
header's reason stands — sessions die without revoking, so a persisted "session X can do Y" is a
stale-capability hazard at the dispatch seam), and add the registry as a **readout-only** input
— it never gates a live take, it only powers the bottleneck projection (§5). A session still
proves its capabilities by probing at ask time; the registry is a planning aid, not an
authority. This keeps the take-decision on fresh evidence while making scarcity visible.

### 5. Bottleneck readout

ADR 0001 axis 3 makes "serving bottleneck stages" a **readout**, not a scheduler in the fold.
Add a `--bottlenecks` projection over the ripe-node frontier grouped by required profile: the
counts of nodes across issues waiting on each scarce profile, so an operator (or a scheduler
built later) can batch them for when that session is up. Pure projection over the same fold +
template — no new fold input, no scheduling authority.

## Open question deferred to build-time

- **Profile schema granularity.** ADR 0001 deliberately chose an *open attribute bag* over a
  fixed grid. The first real nodes (#12 CI-sensor, #13 mockup) will show which attributes are
  load-bearing; grow the bag empirically rather than specifying it up front (ADR 0001 axis 5 —
  new nodes land in shadow, so the profile can be wrong without disrupting live work).

## Does this need its own ADR?

**No.** ADR 0001 already made every *decision* here (capability-typed nodes, matching-in-
dispatch, frontier-as-a-set, scarcity-out-of-the-fold); this is its named follow-up, not a new
architectural choice. The one genuinely new decision — *registry as readout-only, probe as
trust-root* (§4) — is a refinement within ADR 0001's frame and is recorded here. If build-time
surfaces a real fork (e.g. probe proves insufficient and a persisted registry must gate takes),
*that* earns an ADR then. For now: this design doc + #21 + the `goal-liveness.allium` schema
update carry it.

## Sequencing

**Buildable now (no #17 dependency):**

1. This design doc — establishes that phase-aware dispatch generalizes the existing `next.mjs`
   matcher rather than building greenfield, and records the §3–§4 refinements. (No doc
   correction needed: the README / `docs/architecture.md` matches-vs-acts language is accurate
   as written; a one-line pointer from those "No dispatcher" bullets to #21 as the *matcher's*
   next generalization would be a nice-to-have, not a fix.)

**Gated on #17 + ADR 0001 acceptance (`status: proposed`):**

2. `goal-liveness.allium` node/predecessor + profile schema; situational `next`-sync gate in
   shadow (ADR 0002).
3. Per-node `match()` / `requirementsOf` (§1, §2).
4. `workType` node attribute + wrapper router (§3).
5. Registry-as-readout + `--bottlenecks` projection (§4, §5).

Steps 3–5 land node-by-node in shadow (ADR 0001 axis 5): a new profile or work-type is observed
matching real nodes before it gates a real take.
