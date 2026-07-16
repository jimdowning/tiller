#!/usr/bin/env node
// attest.mjs — record a validity verdict (the attestation stamp).
//
//   node src/attest.mjs 123 journey-articulation pass --note "value legible after refinement"
//   node src/attest.mjs 123 value-clear pass --post
//   node src/attest.mjs 123 spec-present pass --source agent --post
//
// This is the STAMP tool for gates whose verdict a session must record — by
// default the operator's (authority: 'operator'; an agent recording its own
// cert must say --source agent, and cannot claim a source above its station:
// the sensed-comment path downgrades over-claims by author ceiling, #23).
// The challenge/refinement conversation happens wherever it happens (an
// interactive session); only its conclusion lands here, as a fact.
//
// TWO DURABILITY MODES:
//   default — append the fact to the LOCAL stateDir fact log. Machine-local:
//             invisible to CI ticks, other worktrees, other machines. Fine
//             for offline/solo work.
//   --post  — post the verdict as a structured `tiller:attest ...` comment on
//             the goal's GitHub issue instead. The next tick (on ANY machine)
//             senses it into a validity-verdict fact: durable, replayable,
//             and auditable in the issue thread. The engine's tick stays
//             structurally read-only; this stamp tool is the one deliberate
//             writer, and only ever of comments.
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FactStore } from './store.mjs';
import { STATE_DIR } from './config.mjs';

const positional = process.argv.slice(2).filter((a, i, all) =>
  !a.startsWith('--') && all[i - 1] !== '--note' && all[i - 1] !== '--source');
const [goalArg, artifact, verdict] = positional;
const goal = Number(goalArg);
const noteIdx = process.argv.indexOf('--note');
const note = noteIdx > -1 ? process.argv[noteIdx + 1] : undefined;
const sourceIdx = process.argv.indexOf('--source');
const source = sourceIdx > -1 ? process.argv[sourceIdx + 1] : 'operator';
const post = process.argv.includes('--post');

if (!goal || !artifact || !['pass', 'fail'].includes(verdict)
  || !['operator', 'agent', 'sensor'].includes(source)) {
  console.error('usage: node src/attest.mjs <issue-number> <artifact> pass|fail'
    + ' [--note "..."] [--source operator|agent|sensor] [--post]');
  process.exit(2);
}

if (post) {
  // the comment format sensed by translate.mjs ATTEST_LINE (#23)
  const body = `tiller:attest ${artifact} ${verdict} source=${source}`
    + (note ? ` — ${note}` : '');
  execFileSync('gh', ['issue', 'comment', String(goal), '--body', body],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  console.log(`posted: #${goal} ${artifact} = ${verdict} (claimed source: ${source}) — `
    + 'the next tick senses it as a validity-verdict fact');
} else {
  const nowTs = new Date().toISOString();
  const store = new FactStore(resolve(STATE_DIR, 'facts.jsonl'));
  const fact = {
    ts: nowTs, kind: 'validity-verdict', goal, artifact, verdict,
    source, ...(note ? { note } : {}),
    key: `vv:${artifact}:${goal}:${nowTs}`,
  };
  const stored = store.append(fact);
  console.log(stored
    ? `recorded locally: #${goal} ${artifact} = ${verdict} (source: ${source}) — `
      + 'machine-local; use --post for a durable, sensed-from-GitHub verdict'
    : 'duplicate — already recorded');
}
