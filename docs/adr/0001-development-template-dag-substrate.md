---
adr: 0001
title: development-template-as-a-capability-typed-dag
status: proposed
date: 2026-07-13
supersedes: []
superseded_by: null
---

# ADR 0001: The development template is a capability-typed DAG with reasoned revalidation

## Context

Tiller already carries a per-goal-type **development template**: `GOAL_TYPES[type].stages`
in `src/templates.mjs` — an ordered list of stages (`delivery`:
`conditioned → implemented → reviewed → merged → verified → done`) whose completion
is derived from artifact-produced facts, and which a consumer repo overrides via a
`DELIVERY_TEMPLATE` export. Two properties of the current shape are load-bearing and
are **kept** by this ADR:

- **Templates are data**, per goal type, config-overridable. Not code paths.
- **Stages are reporting-only** — "the classifier's bucket logic does not depend on
  stages" (`templates.mjs`). The pure total classifier derives `ripe|parked|waiting|done`
  from the fact log; stages are a *projection* over the same facts, decoupled from the
  bucket fold.

The design goal (operator) is that this template be the canonical "development path" an
issue moves along — one we can **shift issues around on** and **adjust**, grown empirically
with real issues rather than specified up front. Three real use cases show the current
*linear list* is insufficient and force a **DAG**:

1. **Fan-in / convergence.** A UI feature's `implement` stage has two prerequisites that
   proceed in parallel and join: `mockup-approved` **and** `spec-resolved`. A list cannot
   express "both, in parallel, then converge."
2. **Capability-typed nodes.** A stage is not just work — it is work that can only execute
   in a session with a given capability profile. Example (mobile app): *writing* putative
   integration tests runs in a sandboxed, high-autonomy session with no network; *running*
   those tests needs a session with a mobile simulator + network + Bluetooth, which is
   hard to sandbox and so runs with permission-checking on (non-autonomous). Different
   stages of one issue require different execution environments; a scarce-capability stage
   is a **bottleneck** to batch work toward.
3. **The double-diamond front-end (near-term).** Extending the template at the front —
   problem-exploration → problem-clarified → solution-alternatives → selection → spec —
   is inherently diverge/converge (a small first diamond over *what the user problem is*,
   a second over *how to solve it*). That is a DAG, not a list.

## Decision

Evolve the template substrate along five axes. **Fix the substrate now; grow the topology
(which nodes exist) empirically.** Because a node's position is *derived from the DAG, never
stored*, adding, splitting, or re-tagging nodes costs nothing to in-flight work — it re-slots
on the next tick.

### 1. Stages become a DAG

`GOAL_TYPES[type].stages` (an ordered list) generalizes to a set of **nodes with declared
predecessors** (fan-in and fan-out). A node's **phase position is derived**, never stored:
the fold already derives everything from facts, and a stored, mutable phase field would be a
second source of truth that can disagree with the append-only log — the exact foreign body the
pure-fold identity exists to avoid.

The **effective per-issue DAG** is the subgraph whose nodes' `appliesWhen` predicate matches
that issue (the existing gate mechanism: `goalType` / `bodyCites` / `labelsInclude`). A backend
issue's subgraph omits `mockup-approved`; a no-spec issue omits `spec-resolved`. One canonical
superset; each issue's path is the matched subgraph — **no companion issues, no sub-issues, no
stored sub-state.** (This dissolves the companion-vs-sub-issue question: a prep step like a UI
mockup is simply one node in the canonical DAG.)

### 2. Nodes are capability-typed — via an open attribute bag, not fixed axes

Each node carries a required **execution-environment profile**. The profile is an **open,
extensible set of attributes**, deliberately *not* a fixed `(capability × trust)` grid — what
looks like "capability" bundles several unlike things:

- whether an **interacting operator is present**,
- the **model tier** of the session,
- the **harness / environment tooling** available (simulator, network, Bluetooth, …),
- the **sandbox posture** of the environment.

**Non-interactive-executability is a *derived* flag**, not a primitive axis: it falls out of
sandbox posture + operator-presence (an environment that can host a mobile simulator but cannot
be fully sandboxed runs with permission-checking on, i.e. non-autonomous). This generalizes
tiller's existing `conditioned ⇒ startable with zero synchronous operator input` doctrine from a
**blanket rule** to a **per-node attribute**: a node that inherently needs an operator (approve
a UI mockup; run a permission-checked simulator session) matches only a session that provides
operator-presence. **Lethal-trifecta** mitigation stays where it belongs — baked into each
environment's capability design — and is consumed by the matcher as "what this environment may
safely do," never re-derived by tiller.

### 3. Pure classifier / matching dispatch — preserve the current boundary

The classifier stays **capability-agnostic and pure**. It derives *readiness only*: a node is
**ripe** when all its predecessors are satisfied and its own verdict is absent or stale. The
**frontier is a set** — multiple parallel nodes can be ripe at once (mockup ∥ spec-resolution),
each possibly requiring a different environment profile.

Capability-matching and bottleneck scheduling live **entirely in dispatch**: a ripe node
requiring profile *P* is routed to a session whose attributes ⊇ *P*; a ripe node with no capable
session simply **sits — visible and queued — without changing the fold.** This keeps the fold a
pure total function (session availability never leaks into classification, so the derived plan
stays deterministic) and is continuous with today's architecture (stages already reporting-only,
decoupled from bucket logic). "Serving bottleneck stages" is then a **readout** over the frontier
+ profile tags: *these N nodes across M issues are all queued on a high-capability mobile session*
— so you batch them for when that scarce session is up.

### 4. Revalidation is reasoned, not a mechanical cascade — and a fact *producer*, not part of the fold

Mechanical downstream invalidation (kill an upstream verdict → re-open its transitive downstream)
is both **forward-only** and **blunt**. Forward-only misses the case that matters most: a
**downstream node's findings contradicting an *upstream* node's assumption** — an integration-test
run discovering the logic assumed the wrong API contract, invalidating the `spec-resolved` /
`implemented` node *behind* it. Edges point forward; that contradiction runs backward against them,
and no edge-walk can find it. Blunt re-opens work that is still valid.

So revalidation is **reasoned**:

- Each node emits, besides its verdict, the **assumptions its output rests on**.
- When any node produces findings, a **reasoning step** (an agent/sensor-authority revalidation
  producer) asks: *do these findings contradict any completed node's recorded assumptions?* and
  emits **targeted contradiction facts** — re-opening only what is genuinely undermined, in any
  direction.
- The **fold stays pure**: the reasoning is a fact *producer*, not part of the classifier. The
  agent judges scope and appends contradiction facts; the fold mechanically re-opens whatever those
  facts name. Reasoning decides *scope*; the fold does *propagation*.

The existing **body-hash latch is retained as the cheap mechanical approximation** of
"assumptions may have changed" (the issue text moved, so *maybe* they did). The reasoned
assumption-check is the general case, spent only where a blunt hash would over- or under-fire.
The DAG's role in revalidation shrinks to **bounding candidate nodes and ordering re-execution** —
not deciding invalidation.

### 5. New nodes land in shadow

A node added to a DAG starts in `mode: 'shadow'`: it is evaluated every tick and **records what it
*would* gate, but appends no park fact** — it blocks nothing. It is promoted to `mode: 'enforce'`
**one node at a time, on its own divergence record**, once it is observed to fire correctly rather
than over-constrain. This is tiller's existing shadow-first gate rollout, and it is precisely what
makes "feel our way into the topology with real issues" safe — new topology is **observable before
it is binding**. It is also why **heavy grandfathering of in-flight issues is unnecessary** (operator
decision: grandfathering would be ideal but is not worth the implementation complexity): a newly-added
node observes issues flowing past in shadow and disrupts none until deliberately enforced.

## Consequences

- **Substrate fixed, topology fluid.** Axes 1–5 are the stable contract. The canonical node set —
  especially the double-diamond front — is grown incrementally with real issues, at zero cost to
  in-flight work, because position is derived not stored.
- **`reviewed` becomes conditional, not universal.** It gates only when a change carries a decision
  worth surfacing — seeded from the durable pre-merge set `{architectural, irreversible, cost}` plus
  UI — via `appliesWhen`. Everything else flows to the supervisor's auto-merge; the operator sees only
  decision-bearing PRs. (Operator: "I don't want to rubber-stamp PRs.")
- **Queued instances become nodes.** The UI-mockup prep gate (#13) and CI-as-sensor-attester (#12)
  are the first two nodes authored on this substrate, not standalone features. #12's nightly-e2e is a
  `sensor`-authority node; #13's mockup is an `agent`-drafts → `operator`-approves node.
- **Three authority classes, one model.** `sensor` (a command/CI run decides), `agent` (produces an
  artifact for another to judge), `operator` (a human stamp) — one attestation model across every node.
- **Classifier-spec-sync applies at build time.** Implementing axes 1–4 touches the classifier/fold, so
  the `spec/goal-liveness.allium` update + operator attestation gate binds when code lands. **This ADR is
  design-only (`status: proposed`)** — no classifier, template, or spec change is made here.

## Alternatives considered

- **A stored phase field** (a Jira-style status column / explicit per-issue state machine that is
  *transitioned*). Rejected: a second mutable source of truth that can silently disagree with the
  append-only fact log, defeating the pure-fold identity, and forcing a state migration on every
  template edit. Deriving phase from gate-satisfaction facts keeps one source of truth and makes
  template edits re-slot every issue for free.
- **Keep the linear stage list** (the current shape). Rejected: cannot express fan-in convergence,
  capability-parallel branches, or the double-diamond front — all present in real use cases.
- **A capability-aware classifier** (session availability influences ripeness). Rejected: makes the
  fold non-deterministic (the derived plan would depend on which sessions happen to be running) and
  entangles scheduling with classification. Scarcity belongs in dispatch.
- **Mechanical downstream invalidation cascade.** Rejected: forward-only (misses downstream findings
  contradicting an upstream assumption) and blunt (re-opens still-valid work). Replaced by reasoned,
  fact-producing revalidation.
- **A fixed `(capability × trust)` axis schema.** Rejected: "capability" bundles operator-presence,
  model tier, and tooling; "trust" collapses into derived non-interactive-executability. An open
  attribute bag with a derived autonomy flag is truer and stays extensible.

## Follow-ups

- Formalize the node/predecessor + profile schema and the reasoned-revalidation authority in
  `spec/goal-liveness.allium` when the first node graduates from reporting-only to bucket/dispatch-affecting.
- Define the canonical `delivery` DAG topology incrementally — start from
  `conditioned → (spec-resolved ∥ mockup-approved) → implemented → [reviewed?] → merged → verified → done`,
  add the front diamond when we feel our way into it.
- Build capability-matched dispatch: the matcher + a session-capability registry (session attributes ⊇
  node requirements). Separate from this substrate — tiller currently dispatches nothing.
- Author #12 (CI sensor node) and #13 (mockup agent→operator node) against this substrate once axes 1–3
  land in the engine.
