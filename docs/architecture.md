# Architecture

How the engine is wired, for someone reading the code. The [README](../README.md)
gives the five-stage overview and [Concepts](concepts.md) explains the ideas; this
page maps them onto modules, states the contract, and covers the safety and
determinism properties — then the honest limitations.

- [The pipeline, module by module](#pipeline)
- [The classifier contract spec](#contract)
- [Determinism and replayability](#determinism)
- [Degraded senses fail loudly](#degraded-senses)
- [Templates and the DAG substrate](#templates)
- [Current status & limitations](#current-status--limitations)

<a id="pipeline"></a>
## The pipeline, module by module

A tick flows top to bottom. Each stage is a module in `src/`; the left column is
data coming _in_, the right column is durable state.

```
GitHub (read-only)                          state/facts.jsonl (append-only)
   │  sense/github.mjs   — fetch the open set, timelines, comments, and bodies.
   │                       The LIST is always full; the per-item drill is
   │                       watermarked on updated_at (#6) — unchanged items are
   ▼                       skipped and keep their prior view (state/sense-watermarks.json).
sense/translate.mjs      — ALL lexical heuristics live here: reading labels,
   │                       task-lists, body markers, and `tiller:attest` comments
   │                       (#23: durable validity verdicts, authority capped by the
   │                       author's ceiling) into facts. This is the one
   │                       deliberately imperative stage — sensing can't be pure,
   ▼                       so it's quarantined here. Event-derived facts carry
   │                       event timestamps, so re-sensing dedups to a no-op.
store.mjs                — content/logical dedup; never modify, never delete
   ▼
classify.mjs             — the PURE total fold: every formed goal in exactly one
   │                       bucket (ripe | parked | waiting | done). Multi-park
   │                       (a goal carries ALL its blockers), generic unpark
   │                       firing, cycle parking, contradictions, liveness
   ▼                       (timeout-repair of dead unpark predicates)
verify.mjs               — the thin verifier over ripe candidates: operator-gated
   │                       / approach-fork / hard-dep-on-open, plus route-floor
   │                       annotation. Verifier parks are body-keyed → an edited
   ▼                       body re-observes and re-verifies automatically.
hysteresis.mjs           — the damping gate (see Concepts). ASYMMETRIC: a goal's
   │                       first ripening dispatches immediately; a goal that has
   │                       de-committed once holds open on re-ripening.
   ▼
tick.mjs                 — orchestration + snapshots/<date>.{json,md}. When the
                           frontier is empty (ripe = holding = 0 with parked
                           goals), the snapshot is marked `starved` and carries
                           the aggregate readout the per-goal wedge audit
                           can't give (#25): parks by reason, unpark events
                           ranked by goals touched.
```

Supporting modules: `gates.mjs` (situational-gate evaluation), `templates.mjs`
(per-goal-type stages), `config.mjs` (config loading + `TILLER_CONFIG`
resolution), `schema.mjs` (fact shapes), `explain.mjs` / `next.mjs` /
`attest.mjs` / `migrate.mjs` / `diagram.mjs` (the CLIs).

The key structural fact: **`translate.mjs` is the only imperative stage.** Sensing
is irreducibly lexical — you have to read text and pattern-match — so all of that
lives in one place, and everything downstream operates on clean facts. The
classifier in particular imports no heuristics; it's a pure fold.

<a id="contract"></a>
## The classifier contract spec

The facts and buckets are specified in
[`spec/goal-liveness.allium`](../spec/goal-liveness.allium) — the classifier's
contract, written in [Allium](https://github.com/juxt/allium-tools). It was
vendored from the experiment artifact that validated the design and is now the
**living contract** for this repo: a change to the classifier or the fold is
expected to update it. That expectation is enforced by the `classifier-spec-sync`
gate (operator-attested) and checked in CI by `scripts/check-spec.mjs`.

<a id="determinism"></a>
## Determinism and replayability

Two properties make the plan trustworthy, and both are structural rather than
best-effort:

- **The fold is pure.** The bucket a goal lands in depends only on the facts —
  never on wall-clock time, running sessions, or hidden state. The tick date is
  _injected_, not read from the clock, so date-gated goals resolve deterministically
  and a tick can be replayed at any time and reproduce its result.
- **Sensing is stateless and idempotent.** Event-derived facts carry the timestamp
  of the event that produced them, so re-sensing the same GitHub state produces
  facts that dedup to a no-op. Combined with the append-only log, this means
  `tick --offline` re-derives the entire plan from stored facts with no network,
  and gets the same answer a live tick would. Attestations posted as
  `tiller:attest` comments (#23) extend this to verdicts: an operator stamp or
  agent cert recorded that way is re-derivable on **any** machine — CI runners,
  worktrees, fresh checkouts — where a locally-appended `attest.mjs` fact exists
  in one `stateDir` only.

Together these are what let the [pin-bump gate](operating.md#pin-bump) work: run
the old and new engine over the same stored facts and diff the buckets — any
difference is a real semantic change, not noise.

<a id="degraded-senses"></a>
## Degraded senses fail loudly

A read-only sensor still has a failure mode: it can be _handed a wrong view of the
world_ and not know it. GitHub search can return a partial result set with
`incomplete_results: true` and no error; a paginated fetch can truncate; the open
set can come back implausibly small. Tiller treats all of these as a
`DegradedSenseError` that **aborts the tick before any fact append, descope
contradiction, or meta write.**

The reasoning is asymmetric on purpose. The append-only fact log would survive a
bogus small sense — a missing issue just wouldn't get new facts. But the `meta`
cache (used to detect shrinkage) would be overwritten with the wrong count, poisoning
the next tick's comparison. So the tick aborts _before_ touching meta. A genuine
mass-close is accepted explicitly with `--accept-shrink`. The default shrink
threshold is "open set dropped below 50% of a previous count of ≥ 5."

The principle: **a degraded sense never clobbers state; it stops the tick and says
why.**

<a id="templates"></a>
## Templates and the DAG substrate

Each goal type carries a **development template**: an ordered set of stages
(`templates.mjs`), config-overridable per consumer via `DELIVERY_TEMPLATE`. Two
properties are load-bearing and deliberately preserved:

- **Templates are data, not code paths** — per goal type, config-overridable.
- **Stages are reporting-only.** The classifier's bucket logic does **not** depend
  on stages; a stage is a _projection_ over the same facts, decoupled from the
  bucket fold. This is what lets a template be edited without a state migration:
  because a goal's position is _derived_ from facts and never stored, adding or
  re-tagging a stage re-slots every in-flight goal on the next tick, for free.

The near-term direction (design-only today) is to generalise the linear stage list
into a **capability-typed DAG** — fan-in/fan-out nodes, each tagged with the
execution environment it needs, with new nodes landing in shadow exactly like
gates. That design and its rationale are in
[ADR 0001](adr/0001-development-template-dag-substrate.md); it changes the template
substrate, not the pure-fold identity above.

<a id="current-status--limitations"></a>
## Current status & limitations

Tiller is **preliminary**. It senses, classifies, and produces a derived plan;
it does **not yet dispatch** — it tells you what's ready, and a human or an agent
picks it up. Each limitation below is a tracked goal in this repo's own backlog
(the self-hosted instance senses them, #7–#10):

- **Sensing is issue-shaped only.** It ingests issue timelines, comments, and
  bodies — not PR reviews, CI `workflow_run` conclusions, or repo-file predicates.
  So the `verified` stage of the delivery template isn't derivable yet. (#7)
- **No heartbeats emitted yet.** `heartbeat` facts are modelled in the classifier
  and schema, but nothing appends them. Wiring loop-driven sessions to emit
  heartbeats is the dead-loop detector, and comes with the entry skills. (#8)
- **Thin stage reporting.** Reporting beyond `conditioned` / `pr#N[-merged]` is
  minimal; the template registry exists and is per-repo overridable, but it only
  gates ripeness via the label contract. (#9)
- **Asymmetric hysteresis is a deliberate simplification** (operator, 2026-07-11).
  A newly-seen ripe goal dispatches immediately — premature ripening never occurred
  in the first live ticks, while the hold-open latency was a real cost. First-commit
  hold-open can be reinstated in one line if churn from a noisier signal ever bites.
- **No dispatcher.** The engine produces the derived plan (the snapshot); the entry
  skills that would _act_ on it aren't built. `next.mjs` matches a session to work,
  but tiller itself dispatches nothing.
- **Re-decomposition isn't automatic.** Decomposition _edges_ are facts, but the
  decomposition _act_ is not — so nothing in the fold triggers re-decomposition when
  a journey's scope is invalidated (spec change, product escalation, child drift),
  and the waste-in-the-large metrics (stale-dispatch exposure) aren't derivable yet.
  The agreed design is
  [`decomposition-freshness.md`](https://github.com/jimdowning/strengthsys/blob/main/design/coordination-model/decomposition-freshness.md)
  (in strengthsys): a `decomposition-verdict` fact with a `needs-decomposition`
  park — the gate pattern applied one level up. (#10)

### A real first tick

For a concrete baseline, the first live tick against strengthsys (2026-07-05)
processed **131 open issues into 671 facts**: ripe 0, holding 2 (exactly the
expected ripe set, held by the hysteresis gate), parked 120, wedges 0. One issue
was closed by the operator _mid-tick_ and the external-resolution path tracked it
to `done` within the same run; another showed both of its real blockers, with the
stale one correctly surfaced as overdue. That tick is preserved at
[`snapshots/2026-07-05.md`](../snapshots/2026-07-05.md).
