#!/usr/bin/env node
// attest.mjs — record an operator-authority validity verdict.
//
//   node src/attest.mjs 123 journey-articulation pass --note "value legible after refinement"
//   node src/attest.mjs 123 journey-articulation fail --note "features listed, no user value"
//
// This is the operator STAMP for gates whose verdict is not the agent's to
// give (authority: 'operator'). The challenge/refinement conversation happens
// wherever it happens (an interactive session); only its conclusion lands
// here, as a fact.
import { resolve } from 'node:path';
import { FactStore } from './store.mjs';
import { STATE_DIR } from './config.mjs';

const [goalArg, artifact, verdict] = process.argv.slice(2);
const goal = Number(goalArg);
const noteIdx = process.argv.indexOf('--note');
const note = noteIdx > -1 ? process.argv[noteIdx + 1] : undefined;

if (!goal || !artifact || !['pass', 'fail'].includes(verdict)) {
  console.error('usage: node src/attest.mjs <issue-number> <artifact> pass|fail [--note "..."]');
  process.exit(2);
}

const nowTs = new Date().toISOString();
const store = new FactStore(resolve(STATE_DIR, 'facts.jsonl'));
const fact = {
  ts: nowTs, kind: 'validity-verdict', goal, artifact, verdict,
  source: 'operator', ...(note ? { note } : {}),
  key: `vv:${artifact}:${goal}:${nowTs}`,
};
const stored = store.append(fact);
console.log(stored
  ? `recorded: #${goal} ${artifact} = ${verdict} (source: operator)`
  : 'duplicate — already recorded');
