#!/usr/bin/env node
// explain.mjs — "why isn't #N ripe, and what exactly would change that?"
//
//   node src/explain.mjs 419            explain one goal from the stored log
//   node src/explain.mjs 419 --json     machine form
//
// Every park already carries its unpark predicate; this renders that state as
// an instruction instead of an obstruction. It is also a design-time filter:
// a gate whose exit can't be stated crisply enough to print here is a gate
// that shouldn't exist yet.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FactStore } from './store.mjs';
import { fold } from './classify.mjs';
import { STATE_DIR } from './config.mjs';

// Humanize unpark disjuncts — what a person would actually do.
const HUMANIZE = {
  'artifact-produced:conditioned':
    'grant the conditioning contract (conditioned + blast-radius:* + reversibility:* labels — operator stamp)',
  'artifact-produced': 'produce a progress artifact for this goal',
  'operator-response':
    'an operator resolution: an **FYI** / `startable: yes` after the ACTION REQUIRED, or removing the operator label',
  'dependency-declared': 'file/link a tracking issue for the untracked dependency',
  'body-observed': 'edit the issue body (it re-verifies automatically)',
  'validity-verdict': 'a passing validity verdict from the relevant check',
  'timeout': 'TTL expiry — surfaces this park as overdue for attention (never releases it)',
  'contradiction': 'retire the offending fact (e.g. break the dependency cycle)',
  'heartbeat': 'a liveness pulse from the owning stream',
};
const human = (d) => HUMANIZE[d] ?? d;

export function explain(goal, classification, facts, hystGoals = {}) {
  const c = classification.get(goal);
  if (!c) return { goal, found: false, text: `#${goal}: no goal-formed fact in the log — not sensed yet (or a PR/meta-tracker).` };

  const L = [`# #${goal} — ${c.title || '(untitled)'}`, ''];
  L.push(`- bucket: **${c.bucket}**${c.goalType !== 'delivery' ? ` (${c.goalType})` : ''}`);
  if (c.artifacts?.length) L.push(`- artifacts: ${c.artifacts.join(', ')}`);

  const gate = hystGoals[goal];
  if (c.bucket === 'ripe') {
    if (gate && gate.committed !== 'ripe') {
      L.push('', 'Raw-ripe but **held by the hysteresis gate** (hold-open): stays held until the');
      L.push(`signal is stable for W ticks. Recent signal: [${gate.signals.join(', ')}].`);
    } else {
      L.push('', '**Dispatchable now.**');
    }
  }

  if (c.bucket === 'waiting') {
    L.push('', `Waiting on: ${c.dependencies.map((d) => {
      const dep = classification.get(d);
      return `#${d} (${dep ? dep.bucket : 'unknown — treated as blocking'})`;
    }).join(', ')}`);
    L.push('Clears when every dependency is done (closes).');
  }

  if (c.bucket === 'parked') {
    // recover evidence from the most recent park fact per active reason
    const evidence = new Map();
    for (const f of facts) {
      if (f.kind === 'park' && f.goal === goal && f.evidence) evidence.set(f.reason, f.evidence);
    }
    L.push('', `${c.parks.length} active blocker${c.parks.length > 1 ? 's' : ''} — ALL must clear:`);
    for (const p of c.parks) {
      L.push('', `## ${p.reason}${p.overdue ? '  ⚠ OVERDUE since ' + String(p.overdue).slice(0, 10) : ''}`);
      if (p.since) L.push(`- parked since ${String(p.since).slice(0, 10)}`);
      if (evidence.has(p.reason)) L.push(`- evidence: ${evidence.get(p.reason).join(' · ')}`);
      L.push('- clears on any of:');
      for (const d of p.unpark.anyOf) L.push(`  - ${human(d)}`);
    }
  }

  if (c.bucket === 'done') L.push('', 'Done (closed). A reopen re-enters a live bucket via contradiction.');

  return { goal, found: true, bucket: c.bucket, parks: c.parks ?? [], text: L.join('\n') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const num = Number(process.argv[2]);
  if (!num) { console.error('usage: node src/explain.mjs <issue-number> [--json]'); process.exit(2); }
  const path = resolve(STATE_DIR, 'facts.jsonl');
  if (!existsSync(path)) { console.error('no state/facts.jsonl — run `node src/tick.mjs` first'); process.exit(2); }
  const store = new FactStore(path);
  const classification = fold(store.all());
  const hystPath = resolve(STATE_DIR, 'hysteresis.json');
  const hyst = existsSync(hystPath) ? JSON.parse(readFileSync(hystPath, 'utf8')).goals : {};
  const result = explain(num, classification, store.all(), hyst);
  console.log(process.argv.includes('--json')
    ? JSON.stringify(result, null, 2)
    : result.text);
}
