# Tiller

**Tiller makes human attention scarce on purpose.** It spends a person's judgement only where a decision genuinely needs one — and surfaces that decision at the earliest, cheapest point to act on it. Everything mechanical, it derives deterministically from your issues, so no one spends attention keeping a plan honest, babysitting an agent session, or rubber-stamping a PR that was already too far gone to really question.

It reads a repository's open issues, folds them into a single derived plan, applies the quality bars each kind of work has to clear _before_ it's dispatched, and surfaces the handful of things that actually need a human. Nothing is hand-maintained; the plan falls out of the facts. Tiller is read-only, deterministic, and has zero runtime dependencies.

> **Status: preliminary — the deterministic substrate, not yet the whole loop.** The engine senses, classifies, gates, and snapshots on every tick. It does **not** dispatch work, run sessions, or touch PRs — those outcomes are delivered by the coordinating system tiller _feeds_ (conditioning, supervision, implementation). What the engine gives that system is a trustworthy, always-current answer to _what's ready, what's blocked and why, and what needs a person._ See [Current status & limitations](docs/architecture.md#current-status--limitations).

---

## Why tiller exists

If you coordinate a large backlog — especially one worked by a mix of humans and autonomous agents — human attention is the bottleneck, and it leaks in three places:

- **Quality caught late is quality rubber-stamped.** When the first real check on a piece of work is PR review, it's already too late to push back cheaply — so, in practice, you don't. Tiller's **gates** move the questions that decide whether work is worth doing well — is it shaped? is its value clear? does it fit the architecture? — _upstream_ to conditioning time, where acting on the answer is a label edit rather than a discarded branch. A new gate can even start in **shadow mode**, reporting what it _would_ block before it binds, so you can see a quality bar's effect before it costs anyone anything.
- **Mechanical work-management eats human attention.** _"What's actually ready?"_ has no cheap answer done by hand: an issue can look ready and not be — it depends on unfinished work, waits on a decision only a person can make, its spec isn't settled, or it's embargoed until a date. _"Why isn't this moving?"_ means re-reading threads to reverse-engineer intent. And milestones and status columns are a second, hand-maintained source of truth that quietly drifts from reality — someone has to keep them honest, and nobody does. All of it is _derivable_; none of it is worth a person's time. Tiller derives it.
- **A bad "what's next" answer is paid downstream, at scale.** An autonomous session that grabs a not-actually-startable issue burns tokens, produces half-work, and creates cleanup — and a human ends up babysitting the session to catch it. Getting readiness right before dispatch is what lets work run without someone watching it.

Tiller exists to make those answers **cheap, current, and trustworthy** — so a person's attention is spent only on the decisions that genuinely need it. You keep working in GitHub issues as normal; tiller derives the plan from them so you never maintain it, and it derives it the same way every time so you can trust it.

## What you get

- **Quality bars enforced before dispatch.** Each kind of work has to clear the **gates** that _its kind_ needs — spec clean, value clear, alternatives considered, architecture fit, operator approved — before it's ever treated as ready. The quality conversation happens upstream, once, where it's cheap; not at PR review, where it's expensive and usually too late. Gates can run in **shadow mode** first, so you see a bar's effect before it binds.
- **Attention rationed to what needs a human.** An operator stamps (`attest`) only the gates that genuinely require judgement; everything mechanical is derived. Blocked work that has waited too long is surfaced as **attention** the moment it crosses its deadline — so the few things that need a person find you, instead of you hunting for them.
- **One always-current plan.** Every issue lands in exactly one bucket — **ready to start**, **blocked**, **waiting on its children**, or **done** — with no gaps and no double-counting. Run a tick and you have today's picture.
- **A reason for every "not yet."** Nothing is blocked silently. Each blocked issue carries _every_ reason it's blocked and the specific event that would clear each one — a label, a dependency closing, an operator's stamp, a date arriving. Ask `explain <issue>` and get the exact list.
- **No hand-maintained state.** No milestones to curate, no status columns to drag. Membership and dependencies are _declared_ in issue bodies; the plan is derived. Editing an issue re-derives its place on the next tick, for free.
- **Safe by construction.** Tiller only _reads_ GitHub. It writes nothing back, dispatches nothing, and can't move your work. The worst a bad tick can do is show you a stale plan.
- **Deterministic and auditable.** The same facts always produce the same plan. Everything tiller senses is recorded in an append-only log, so any decision can be replayed and explained after the fact.
- **Nothing to install.** Plain Node, zero dependencies. Tests run on `node --test`.

## See it in action

A tick writes a dated snapshot — the derived plan in human-readable form. An abridged real one:

```markdown
# Engine tick 3 — 2026-07-05

| bucket  | count |
|---------|-------|
| ripe    |     1 |
| holding |     1 |
| parked  |   120 |
| waiting |     0 |
| done    |     0 |

## Ripe (dispatchable)
- #179 Quota-mode test + scheduling decision · floor:inline

## Ripening (held by hysteresis gate)
- #122 AI generation eval rig: real-API dispatch · floor:fullteam

## Attention (parks past their deadline — surfaced to the operator)
- #419 Design-system affordance primitives
  - untracked-dependency since 2026-06-13   [overdue]

## Parked
- #14 Workout session UI and state machine
  - needs-conditioning — clears when: conditioning is granted
- #419 Design-system affordance primitives
  - needs-conditioning   — clears when: conditioning is granted
  - untracked-dependency — clears when: a tracking issue appears, or the deadline surfaces it
```

The **Attention** section is the part that costs a person anything: one blocked issue has sat past its deadline, so it's surfaced for a human to look at — the other 120 parked issues make no claim on anyone's attention until something changes. The rest is the mechanical byproduct: one issue is ready to dispatch; one just ripened and is being briefly held to confirm it's stable; the parked ones each carry their reasons and what would unblock them. That whole picture is _derived_ from the issues — nobody wrote it.

## How it works

Every **tick** runs the same five-stage pipeline, which is really two moves.

**Derive the plan** — turn the repo's reality into buckets, mechanically:

1. **Sense** — fetch the open issues, their timelines, comments, and bodies from GitHub (read-only).
2. **Store** — translate what it saw into **facts** and append them to a log. Facts are never edited or deleted; a later fact can _contradict_ an earlier one, but the history stays. This is what makes ticks replayable.
3. **Classify** — a pure function folds the whole fact log so that every issue lands in **exactly one** bucket: `ripe` (ready), `parked` (blocked), `waiting` (a parent whose children aren't done), or `done`.

**Left-shift quality and ration attention** — decide what's actually fit to start, and what needs a person:

4. **Verify & gate** — before a `ripe` issue is treated as dispatchable, a thin verifier and a set of **situational gates** check the prerequisites that _this kind_ of work needs (e.g. a spec is clean, an operator has approved). This is where quality moves upstream: a bar that would otherwise be discovered at PR review is enforced before dispatch. New gates start in **shadow mode** — they report what they _would_ block without blocking anything, so a rule's effect is observable before it binds.
5. **Snapshot** — write the derived plan to `.tiller/snapshots/<date>.md` (and `.json`), surfacing what's ready, what's blocked and why, and what has waited long enough to need a human. A short **hysteresis** step damps flicker so a rapidly-toggling issue doesn't churn the plan.

The result is a plan you can trust the same way twice. The concepts in bold — facts, buckets, gates, hysteresis — are the whole mental model; [**Concepts**](docs/concepts.md) explains each one and _why_ it's shaped that way.

## Quick start

From a bare checkout of this repo (the engine runs against its own backlog by default):

```bash
node src/tick.mjs                 # one live reconciliation tick (read-only fetch)
node src/tick.mjs --offline       # re-derive from the stored fact log only (no network)
node src/explain.mjs 419          # why isn't #419 ready, and what exactly would clear it?
node src/next.mjs                 # what can THIS session pick up right now?
node src/attest.mjs 10 journey-articulation pass   # record an operator's approval stamp
```

Development checks (also run in CI):

```bash
node --test 'test/*.test.mjs'     # the test suite
node test/fuzz.mjs                # classifier property fuzzer (the correctness gate)
node scripts/check-spec.mjs spec/goal-liveness.allium   # check the classifier contract spec
```

To point tiller at a **different** repo (e.g. as a submodule), give it a config file — see [Operating tiller](docs/operating.md).

## Workflows

Each kind of goal moves through an ordered set of **stages**, guarded by situational **gates**. These diagrams are generated from the active config (`node src/diagram.mjs`) and checked by CI — don't edit between the markers by hand.

<!-- tiller:workflows:start -->
### delivery

```mermaid
graph LR
  classDef gate fill:#fff,stroke:#999,stroke-dasharray:4 3;
  classDef enforce stroke:#c00,stroke-width:2px;
  s_shaped("shaped")
  s_ripe("ripe")
  s_pr_open("pr-open")
  s_merged("merged")
  s_shaped -->|requires label 'shaped'| s_ripe
  s_ripe --> s_pr_open
  s_pr_open --> s_merged
  g_classifier_fuzz{{"classifier-fuzz<br/>when cites src/(classify|schema).mjs<br/>sensor · fuzz-run · shadow"}}
  g_classifier_fuzz -.gate.-> s_ripe
  class g_classifier_fuzz gate
  g_classifier_spec_sync{{"classifier-spec-sync<br/>when cites src/(classify|schema).mjs<br/>operator · spec-sync · shadow"}}
  g_classifier_spec_sync -.gate.-> s_ripe
  class g_classifier_spec_sync gate
  g_value_clear{{"value-clear<br/>when always<br/>operator · value-clear · shadow"}}
  g_value_clear -.gate.-> s_ripe
  class g_value_clear gate
  g_spec_present{{"spec-present<br/>when always<br/>agent · spec-present · shadow"}}
  g_spec_present -.gate.-> s_ripe
  class g_spec_present gate
  g_spec_check_clean{{"spec-check-clean<br/>when cites spec/[A-Za-z0-9_-]+.allium<br/>sensor · spec-check · shadow"}}
  g_spec_check_clean -.gate.-> s_ripe
  class g_spec_check_clean gate
  g_alternatives_considered{{"alternatives-considered<br/>when label nontrivial<br/>agent · alternatives-considered · shadow"}}
  g_alternatives_considered -.gate.-> s_ripe
  class g_alternatives_considered gate
  g_arch_fit{{"arch-fit<br/>when label nontrivial<br/>operator · arch-fit · shadow"}}
  g_arch_fit -.gate.-> s_ripe
  class g_arch_fit gate
```

### journey

```mermaid
graph LR
  classDef gate fill:#fff,stroke:#999,stroke-dasharray:4 3;
  classDef enforce stroke:#c00,stroke-width:2px;
  s_elaborated("elaborated")
  s_children_done("children-done")
  s_closed("closed")
  s_elaborated --> s_children_done
  s_children_done --> s_closed
```
<!-- tiller:workflows:end -->

## Learn more

- [**Concepts**](docs/concepts.md) — the mental model in depth: the fact log, the four buckets, the classifier, situational gates, hysteresis, why there are no milestones, and the full catalogue of "blocked" reasons.
- [**Operating tiller**](docs/operating.md) — every command, configuration (`TILLER_CONFIG` and the config exports), running against a target repo, self-hosting, the consumer pin-bump gate, and CI.
- [**Architecture**](docs/architecture.md) — the internal pipeline module by module, the classifier contract spec, how ticks stay deterministic and degraded senses fail safely, and the current status & limitations.

## Origin & license

Tiller was extracted (history-preserving) from
[jimdowning/strengthsys](https://github.com/jimdowning/strengthsys), where the
engine grew up at `design/coordination-model/engine/`. It was built from a
series of validated experiments (E0–E6); those experiments, their corpus, and
the `SYNTHESIS.md` that records the design evidence stay in strengthsys under
[design/coordination-model](https://github.com/jimdowning/strengthsys/tree/main/design/coordination-model).

Licensed under the terms in [LICENSE](LICENSE).
