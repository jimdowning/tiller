# Concepts — how tiller thinks

This page explains tiller's mental model in depth. It builds on the five-stage
pipeline in the [README](../README.md#how-it-works); read that first. Everything
here is about _why_ tiller is shaped the way it is — the parts that are easy to
misunderstand if you only read the code.

- [Goals, not tickets](#goals-not-tickets)
- [The fact log: append-only, contradict-never-retract](#the-fact-log)
- [The four buckets and the pure classifier](#the-four-buckets)
- [Why there are no milestones](#why-there-are-no-milestones)
- [Journeys: parents that wait on their children](#journeys)
- [The verifier and situational gates](#gates)
- [Hysteresis: damping the flicker](#hysteresis)
- [The catalogue of "blocked" reasons](#blocked-reasons)

<a id="goals-not-tickets"></a>
## Goals, not tickets

Tiller reasons about **goals**. In practice a goal is a GitHub issue, but the
word matters: a goal is a _unit of intended work with a lifecycle_, not a row in
a tracker. A goal can be a single deliverable ("add a skip-set button"), or a
larger **journey** that is delivered through its children. Every goal, whatever
its size, is classified the same way and ends up in exactly one bucket.

<a id="the-fact-log"></a>
## The fact log: append-only, contradict-never-retract

Everything tiller knows is a **fact**, and every fact it has ever sensed lives in
an append-only log (`.tiller/state/facts.jsonl`). Facts are **never edited and
never deleted**. When the world changes — a label is removed, a dependency
closes, an issue is descoped — tiller does not go back and rewrite history; it
_appends a new fact that contradicts the old one_. The old fact stays in the log;
it's just no longer the latest word on its subject.

This one decision buys several properties:

- **Replayability.** Because sensing is stateless and event-derived facts carry
  the timestamp of the event that produced them, re-sensing the same GitHub state
  produces the same facts — re-observing dedups to a no-op. You can re-derive the
  whole plan from the stored log with no network at all (`tick --offline`), and
  get the same answer.
- **Auditability.** Any decision can be explained after the fact by reading the
  facts that led to it. Nothing is lost to an in-place update.
- **Conflict-free storage.** Because facts are only ever appended (and pruned by
  supersession, never mutated), concurrent writers and merges never collide on a
  fact. There is no modify/modify case to resolve.

"Contradicted, never retracted" is the phrase to remember. A descoped child, for
instance, isn't erased — a `contradiction` fact retires the membership edge, and
the history of "this used to be in scope" survives.

<a id="the-four-buckets"></a>
## The four buckets and the pure classifier

The heart of tiller is a **pure, total classifier**. Given the fact log, it folds
every formed goal into **exactly one** of four buckets:

| bucket | meaning |
|---|---|
| **`ripe`** | ready to start — nothing is blocking it |
| **`parked`** | blocked — carrying one or more reasons, each with a way to clear |
| **`waiting`** | a parent (journey) whose children aren't all done yet |
| **`done`** | closed / delivered |

Two words in "pure, total classifier" are load-bearing:

- **Total** — every goal lands _somewhere_. There is no "unclassified" state, no
  goal that falls through the cracks. This is checked continuously by a property
  fuzzer (12,000 randomized fact-logs per run, the CI correctness gate): whatever
  facts you throw at it, exactly one bucket comes out.
- **Pure** — the bucket is a function of the facts and nothing else. It does not
  depend on which sessions are running, what time the machine thinks it is, or any
  hidden state. Same facts in, same buckets out. This is what makes the plan
  trustworthy: two people running a tick over the same log see the same picture.

Everything downstream — verification, gates, hysteresis — is a _projection_ over
this fold, never a change to it. Keeping session availability, scheduling, and
capability-matching out of the classifier is deliberate: the moment those leak in,
the plan stops being deterministic.

<a id="why-there-are-no-milestones"></a>
## Why there are no milestones

Tiller reads **no milestones.** This is a design choice, not a limitation. A
milestone is a side-channel: membership lives in GitHub's milestone field, which
is a second source of truth that has to be curated by hand and drifts from
reality. Every job a milestone did maps onto a plain-issue construct that tiller
can sense with ordinary issue APIs, where membership is **declared in a body** —
and a declared edge is a fact:

| milestone job | issues-only replacement |
|---|---|
| membership (issue ∈ milestone) | a **journey** issue (`goal:journey` label) whose body task-list (`- [ ] #N`) declares its children — or `Part of #N` in a child's body |
| `[CURRENT]` / `[NEXT]` markers | `focus:current` / `focus:next` labels on the journey issue |
| the "PO todo" bucket | a `po-todo` label |
| "is the milestone done?" | derived: a journey `waiting` on its children ripens when they're all done — its ripeness _is_ the transition decision surfacing |

The rule is: **membership must be declared, not implied.** Deleting a task-list
line descopes that child (a `contradiction` fact retires the edge). Because the
edge is a fact, it participates in the same replayable, auditable history as
everything else.

<a id="journeys"></a>
## Journeys: parents that wait on their children

A **journey** is a goal delivered through child goals. It sits in the `waiting`
bucket while any child is unfinished, and **ripens the moment all its children are
done**. That ripeness is not a counter someone maintains — it's derived from the
children's buckets. Two consequences worth internalising:

- The "is this milestone complete?" question answers itself: the journey becoming
  `ripe` _is_ the completion signal surfacing in the plan.
- A journey cannot deadlock on counting itself — no goal's readiness is expressed
  as a self-count, so there's no "waiting for myself" cycle to get stuck in.

<a id="gates"></a>
## The verifier and situational gates

A goal can be un-blocked by the classifier and still not be _dispatchable_. Some
work has prerequisites that only apply in certain situations — and those
prerequisites shouldn't complicate the pure fold. Two layers handle this after
classification:

**The verifier** is a thin check over `ripe` candidates. It catches the goals that
are structurally not startable — operator-gated, an unresolved approach fork, a
hard dependency still open — and annotates each dispatchable goal with a "route
floor" (roughly, how much ceremony this work needs). The verifier's parks are
keyed to the issue body, so **editing the body re-observes and re-verifies
automatically** on the next tick.

**Situational gates** encode "this kind of work needs this prework first." A gate
is declared as _(situation predicate) → (required verdict)_. It binds **only** in
the situations that make its prework necessary — never universally. Two live
examples:

- `spec-check-clean` — a goal whose body cites a `spec/*.allium` file requires a
  passing spec check. The check is keyed by input hash, so unchanged specs never
  re-run; a spec edit supersedes the old verdict. A _failing_ verdict never
  unblocks a goal.
- `journey-articulation` — a `goal:journey` requires an approval verdict whose
  fact was recorded by an **operator** (via `attest.mjs`). An agent may run the
  refinement conversation, but an agent-sourced pass does not satisfy the gate.
  This distinguishes the three **authority classes** every verdict carries:
  `sensor` (a command or CI run decides), `agent` (produces an artifact for
  another to judge), and `operator` (a human stamp).

### Shadow mode: observe before you bind

A brand-new gate is dangerous: turn it on across a live backlog and it might
freeze everything. So every gate **starts in shadow mode** — each tick reports
what it _would_ block, but appends no park fact and blocks nothing. You watch it
for a while, confirm it fires where it should and not where it shouldn't, and only
then graduate it to **enforce**, one gate at a time, on its own record. This is
why a new rule is safe to add: its effect is observable before it is binding.

> Concretely, the first shadow datapoint here was stark: **55 of 55 spec-citing
> goals would have parked** on `spec-check-clean`, because every current spec
> carries warnings. Enforcing on day one would have frozen the backlog. Shadow
> mode surfaced that before it did any damage; where to set the pass/fail
> threshold is now a calibration decision made with real data in hand.

<a id="hysteresis"></a>
## Hysteresis: damping the flicker

Some signals are noisy. A goal can ripen, un-ripen, and re-ripen across
consecutive ticks — for example when its readiness depends on a judgement that
isn't perfectly stable. Dispatching on every flicker would churn work. **Hysteresis**
is a small damping step between raw ripeness and the plan.

It is deliberately **asymmetric**:

- A goal's **first** ripening dispatches **immediately** — no hold-open delay.
  Premature ripening simply hadn't happened in practice, while the delay was a
  real cost, so first-time readiness is trusted.
- Once a goal has ripened, briefly de-committed, and is re-ripening, _that_ goal
  has proven flicker-prone — so re-ripening is held open for a few ticks to
  confirm it's stable before it re-enters the plan.

This shows up in the snapshot as the **holding / "ripening"** line: a goal that
just re-ripened and is being confirmed. If the damping ever gets in the way, it
can be turned off for a single run (`tick --no-hysteresis` reports raw ripeness).

<a id="blocked-reasons"></a>
## The catalogue of "blocked" reasons

`parked` is never a bare state — a parked goal always carries the specific reasons
it's blocked and, for each, the event that clears it. A goal can carry **several
at once** (multi-park): it holds a _set_ of parks keyed by reason, and it only
ripens when **every** park clears. The main reasons:

- **`needs-conditioning`** — the work isn't yet understood well enough to start.
  Clears when conditioning is granted (an operator stamp, per the label contract).
  A mere PR artifact does _not_ clear it — the unpark condition is qualified to the
  conditioning grant specifically.
- **`untracked-dependency`** — the goal depends on something that has no tracking
  issue. Clears when a tracking issue appears, a derisking reversal lands, or the
  deadline surfaces it. (Un-tracked dependencies park rather than silently
  proceed.)
- **date gates** — a body line `earliest-start: YYYY-MM-DD` or a
  `gated-until:YYYY-MM-DD` label parks an otherwise-ready goal until the **tick
  date** reaches it, then clears itself with no operator action. This separates
  _"not yet time"_ (a legitimate wait on a date) from _"not yet understood"_
  (needs-conditioning), so a well-understood-but-embargoed goal doesn't have to be
  left un-conditioned just to keep it undispatched. The comparison uses an injected
  tick date, so ticks stay deterministic and replayable.
- **cycle parking** — if goals form a dependency cycle, they park rather than
  deadlock silently.
- **timeouts (overdue)** — a park that sits past its time-to-live gets a
  manufactured `timeout` fact that marks it **overdue** and surfaces it in the
  snapshot's Attention section. Crucially, a timeout **never clears the park** —
  it only escalates it. A silent self-release would let stuck work quietly slip
  back into "ready," which is exactly the failure this guards against.
- **externals** — a reference pointing outside the sensed open set is resolved
  read-only, so a _closed_ dependency reads as done rather than absent. A reference
  that can't be resolved stays blocking — the safe, re-checkable default.

The common thread: **nothing is blocked silently, and nothing un-blocks itself
except by a rule you can point to.** That's what makes `explain <issue>`
trustworthy — it reads these reasons straight back to you.

---

Next: [**Architecture**](architecture.md) for how these ideas are wired into the
pipeline, or [**Operating tiller**](operating.md) to run it.
