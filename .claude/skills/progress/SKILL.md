---
name: progress
description: Pick the lowest-numbered ripe issue and drive it to landed under tiller's thin process — sync, tick, satisfy the situational gates' prework, implement, and push direct to main. Fully non-interactive: it only touches shaped (ripe) work and never stops mid-run to ask. Triggers — "progress the next issue", "pick a ripe issue and progress it", "work the next ripe issue", "run progress".
---

# progress

Tiller senses and classifies but dispatches nothing. This skill is the
**non-interactive** driver that picks up ripe work and lands it. All operator
judgement lives *upstream* in **shaping** (adding the `shaped` label); this skill
only ever touches ripe work and runs end-to-end with **zero mid-run questions**.

Design: [`docs/superpowers/specs/2026-07-14-progress-skill-design.md`](../../../docs/superpowers/specs/2026-07-14-progress-skill-design.md).

## The one rule

A run is cleanly non-interactive. It never pauses to ask the operator anything.
Its two allowed endings are **landed a change** or **clean exit with a report**.
If you find yourself wanting to ask a question, the issue was not actually ripe —
stop and report that instead of asking.

## Steps (from the repo root)

1. **Sync.** Fast-forward `main` to origin; refuse to clobber:

       git fetch origin && git merge --ff-only origin/main

   If the tree is dirty or the merge is not a clean fast-forward, **stop and
   report** — do not reset, stash, or force. In-flight work (other worktrees,
   uncommitted snapshots) is not yours to move.

2. **Tick.** Produce today's derived plan and snapshot:

       TILLER_CONFIG=./tiller.config.mjs node src/tick.mjs

3. **Select.** Read the `ripe` bucket from the fresh snapshot
   (`.tiller/snapshots/<date>.md`) and take the **lowest issue number**. If the
   bucket is empty: report `nothing shaped — shape an issue to progress it` and
   **exit cleanly**. That clean exit is the contract, not a failure.

4. **Consider the gates — do their prework, never pause for a stamp.** List the
   gates binding the chosen issue:

       TILLER_CONFIG=./tiller.config.mjs node src/explain.mjs <n>

   Satisfy each applicable gate by *doing the work it calls for*, by authority:

   | authority  | example gates                              | what this skill does |
   |------------|--------------------------------------------|----------------------|
   | `sensor`   | `classifier-fuzz`                          | run the sensor command (`node test/fuzz.mjs 5000`) and let the verdict stand |
   | `agent`    | `spec-present`, `alternatives-considered`  | satisfy in the change + commit message; certify it |
   | `operator` | `value-clear`, `arch-fit`, `classifier-spec-sync` | do the *substance* (e.g. write the `spec/goal-liveness.allium` update); leave the **stamp** to the operator as a pending-attest note — never a mid-run block |

   The gates are in `shadow` mode (non-blocking) and the `shaped` label already
   carried the operator's up-front judgement, so landing proceeds. The operator
   attests operator-authority gates later, at their discretion, via
   `node src/attest.mjs <n> <gate> pass`. This skill does **not** self-attest
   operator gates (an agent-sourced pass does not satisfy an operator gate).

5. **Implement & land.** Make the change; run the checks:

       node --test 'test/*.test.mjs'
       node test/fuzz.mjs 5000        # when a fold/classifier gate applied

   Then land **direct to `main`** (fast-forward), per tiller's direct-to-main
   convention, and commit the refreshed snapshot. Open a **draft PR instead of
   pushing** only if the change is strongly contested — then report that.

6. **Report.** One summary: issue picked, each gate considered + the prework
   done for it, the landed commit SHA, and any operator-attest left pending.

## Notes

- **Do not bump a consumer's submodule pin.** A consumer (e.g. strengthsys) is
  insulated by its pin; nothing landed here reaches it until a deliberate,
  separately-reviewed pin bump. That is out of scope for this skill.
- **Do not change a gate's mode** (`shadow` <-> `enforce`). Graduation is its
  own divergence-record-driven decision.
- **Shaping is not this skill's job.** It never decides *what* becomes ripe; it
  only progresses what the operator has already shaped.
