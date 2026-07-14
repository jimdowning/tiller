# Design: `progress` skill — non-interactive ripe-work driver

Date: 2026-07-14

## Problem

Tiller senses, classifies, and produces a derived plan, but **dispatches
nothing** — a human or agent still has to pick ripe work up and move it. Doing
that by hand means: remembering to sync, running a tick, reading the snapshot,
finding the lowest-numbered ripe issue, recalling which situational gates apply
to it, doing the prework those gates want, implementing, and landing under
tiller's thin direct-to-main convention. That is a repeatable loop with no
entry point.

## Job to be done

**When** I have shaped one or more issues as ready, **I want** a single command
that picks up the next ripe one and drives it to landed under tiller's own thin
process, **so that** ripe work moves without me re-deriving the loop each time —
and without the command ever stopping mid-run to ask me something.

## The interactive / non-interactive split (design axis)

Operator efficiency in tiller projects depends on a session being cleanly
**either** interactive **or** non-interactive — never a long silent stretch
punctuated by a question. This skill is the **non-interactive** half. All
operator judgement is front-loaded into **shaping**: the operator adds the
`shaped` label when *they* have decided an issue is ready. The skill then only
ever touches **ripe** (shaped) work and runs end-to-end with zero mid-run
questions. Shaping is the interactive act; progressing is the non-interactive
act; the `shaped` label is the handoff between them. This mirrors tiller's own
#9 self-development loop (operator shapes -> engine senses ripe -> land).

Consequences of the split, made explicit:

- **Selection is deterministic** (lowest-numbered ripe issue) so no pick
  requires a prompt.
- **No ripe work is a clean exit**, not a question. Nothing shaped -> the skill
  reports "nothing shaped — shape an issue to progress it" and stops.
- **Gates are honored by doing their prework, never by pausing for a stamp**
  (see below).

## What one run does

1. **Sync.** In the repo: `git fetch origin`, fast-forward `main` to
   `origin/main`. If the working tree is dirty or the fast-forward is not clean,
   **stop and report** — never clobber in-flight work.
2. **Tick.** `TILLER_CONFIG=./tiller.config.mjs node src/tick.mjs` -> today's
   derived plan and snapshot.
3. **Select.** Among goals in the `ripe` bucket, pick the **lowest issue
   number**. If the bucket is empty, clean-exit (above).
4. **Consider the gates — do the prework, don't pause.** From
   `explain.mjs <n>`, take the gates whose `appliesWhen` binds to the chosen
   issue and satisfy each *by doing the work it calls for*, as part of the
   change:
   - **sensor-authority** (e.g. `classifier-fuzz`): run the sensor command
     mechanically (`node test/fuzz.mjs ...`) and let the verdict stand.
   - **agent-authority** (e.g. `spec-present`, `alternatives-considered`):
     satisfy in the change and commit message; the agent certifies these.
   - **operator-authority** (e.g. `value-clear`, `arch-fit`,
     `classifier-spec-sync`): do the *substance* (e.g. write the
     `spec/goal-liveness.allium` update the gate wants), but leave the **stamp**
     to the operator — recorded as a pending-attest note in the run report,
     **never** a mid-run block. The gates are in `shadow` mode (non-blocking)
     and shaping already carried the operator's up-front judgement, so landing
     proceeds; the operator attests later via `attest.mjs` if they choose.
5. **Implement & land.** Make the change; run `node --test` and the applicable
   sensor gate; land **direct to `main`** (fast-forward push, per tiller's
   direct-to-main convention). Commit the refreshed snapshot. Open a PR **only**
   if the change is strongly contested — then draft it and report instead of
   pushing to main.
6. **Report.** One summary: issue picked, gates considered and the prework done
   for each, what landed (commit SHA), and any operator-attest left pending.

## Out of scope

- **Bumping a consumer's submodule pin** to the newly-landed tiller SHA. That
  stays a deliberate, separately-reviewed act (a consumer is insulated by its
  pin; nothing this skill does reaches the consumer until a pin bump).
- **Interactive shaping or selection.** The operator shapes; the skill does not
  choose *what* becomes ripe.
- **Changing any gate's mode** (shadow <-> enforce). Graduation is its own,
  divergence-record-driven decision.

## Why not the alternatives

- *Take any low-numbered open issue and shape-then-progress it.* Rejected: it
  folds the interactive shaping judgement into the run, reintroducing exactly
  the silent-stretch-then-question shape the split exists to avoid.
- *Plan, then stop for approval before implementing.* Rejected for the same
  reason — it is a non-interactive stretch ending in a question.
- *Enforce the gates as hard blocks.* Rejected: the gates are deliberately in
  shadow; the value here is doing their prework, not gating landing on a stamp
  the shaped label already stands in for.

## Form

A repo-native skill at `.claude/skills/progress/SKILL.md`, matching the existing
`render-workflows` skill's thin shape (frontmatter `name`/`description` with
triggers, a short command-oriented body). It is distributed **with tiller** and
invoked from a tiller checkout — the first instance of the repo-native skill
set (#19).
