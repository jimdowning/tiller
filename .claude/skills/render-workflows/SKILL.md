---
name: render-workflows
description: Regenerate the README "Workflows" mermaid diagrams from the active tiller config. Use after changing any goal type's stages, the DELIVERY_TEMPLATE, or the GATES in engine.config.mjs / tiller.config.mjs — or when a workflow diagram looks stale. Triggers — "render the workflows", "update the workflow diagrams", "regenerate the README DAGs".
---

# render-workflows

`src/diagram.mjs` renders each goal type's workflow — its stages plus the
situational gates guarding `ripe` — as mermaid, and maintains the marked
`## Workflows` section of `README.md`. It reads the **resolved** config exports
(`DELIVERY_TEMPLATE`, `GATES`, `GOAL_TYPES`), so the diagram never disagrees
with what the classifier runs.

## When to run

After any change to workflow topology: a goal type's `stages`, the
`DELIVERY_TEMPLATE` override, or a `GATES` entry (`appliesWhen`, `authority`,
`mode`, `requires.artifact`). CI's `diagram` job runs `--check` and fails the
build if you forget — this skill is how you fix that failure.

## Commands (from the repo root)

Regenerate the README section in place:

    TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --write README.md

Check for drift without writing (what CI runs):

    TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md

Print the section to stdout (e.g. to preview a consumer config):

    TILLER_CONFIG=./path/to/consumer.config.mjs node src/diagram.mjs

## Notes

- Never hand-edit between `<!-- tiller:workflows:start -->` and
  `<!-- tiller:workflows:end -->`; `--write` owns that region.
- The README renders **`tiller.config.mjs`** (the self-hosted thin template
  that governs this repo), not the `engine.config.mjs` fallback.
- Do not edit the mermaid by hand — change the config, then re-run `--write`.
