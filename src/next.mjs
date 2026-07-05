#!/usr/bin/env node
// next.mjs — capability-matched selection over the derived plan.
//
// NOT a queue. Dispatch is a match: each goal carries a required-capability
// set; the asking session presents its available set (probed fresh at ask
// time — never trusted from stale global state, sessions die without
// revoking); the session takes the highest-priority goal whose requirements
// it covers, skipping past goals it can't serve. The operator is just a
// session presenting the `operator-judgement` capability — the po-todo view
// is this command's projection onto it, not a separate mechanism.
//
//   node src/next.mjs                          probe env, list my matches
//   node src/next.mjs --as operator            operator-actionable exits
//   node src/next.mjs --capabilities gh,pnpm   explicit capability set
//   node src/next.mjs --all                    show matched AND skipped (why)
//
// Requirement provenance (increasing honesty):
//   declared — `needs:<capability>` labels; operator-authority gate exits
//   derived  — routeFloor fullteam → interactive
//   learned  — parks with reason `capability:<name>` appended by a session
//              that took a goal and hit a missing tool mid-flight
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactStore } from './store.mjs';
import { fold } from './classify.mjs';
import { GATES } from '../engine.config.mjs';
import { gateApplies, latestVerdict } from './gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- capability probing (ask-time, this environment) -----------------------
const has = (cmd) => {
  try { execFileSync('which', [cmd], { encoding: 'utf8' }); return true; }
  catch { return false; }
};
export function probeCapabilities() {
  const caps = new Set(['agent']);
  for (const tool of ['node', 'pnpm', 'docker', 'gh', 'allium']) {
    if (has(tool)) caps.add(tool);
  }
  if (caps.has('node') && caps.has('pnpm')) caps.add('build-stack');
  if (process.stdout.isTTY || process.env.CLAUDE_INTERACTIVE) caps.add('interactive');
  return caps;
}

// ---- requirement derivation per goal ---------------------------------------
export function requirementsOf(c, m) {
  const req = new Set();
  for (const l of m?.labels ?? []) {
    if (l.startsWith('needs:')) req.add(l.slice('needs:'.length)); // declared
  }
  if (m?.routeFloor === 'fullteam') req.add('interactive');        // derived
  if (c.bucket === 'parked') {
    for (const p of c.parks) {
      if (p.reason.startsWith('capability:')) req.add(p.reason.slice('capability:'.length)); // learned
    }
  }
  return req;
}

// Operator-actionable exits: parked goals whose unpark names an operator act.
const OPERATOR_DISJUNCTS = ['operator-response', 'artifact-produced:conditioned'];
export function operatorActions(classification, meta, facts) {
  const out = [];
  for (const [goal, c] of classification) {
    if (c.goalType === 'external') continue;
    if (c.bucket === 'parked') {
      for (const p of c.parks) {
        const acts = p.unpark.anyOf.filter((d) => OPERATOR_DISJUNCTS.includes(d));
        if (acts.length) out.push({ goal, title: c.title, kind: `resolve park: ${p.reason}`,
          overdue: !!p.overdue, via: acts });
      }
    }
    // operator-authority gate verdicts still outstanding (shadow or enforce)
    for (const g of GATES) {
      if (g.authority !== 'operator' || !gateApplies(g, c, meta.get(goal))) continue;
      if (c.bucket === 'done') continue;
      const v = latestVerdict(facts, goal, g.requires.artifact);
      if (!(v && v.verdict === 'pass' && v.source === g.requires.source)) {
        out.push({ goal, title: c.title, kind: `attest: ${g.requires.artifact}`,
          overdue: false, via: [`node src/attest.mjs ${goal} ${g.requires.artifact} pass|fail`] });
      }
    }
  }
  return out;
}

export function match(classification, meta, caps, hystGoals = {}) {
  const matched = [];
  const skipped = [];
  const focusRank = { current: 0, next: 1 };
  for (const [goal, c] of classification) {
    if (c.bucket !== 'ripe' || c.goalType === 'external') continue;
    const m = meta.get(goal);
    const gate = hystGoals[goal];
    if (gate && gate.committed !== 'ripe') {
      skipped.push({ goal, title: c.title, why: 'held by hysteresis gate' });
      continue;
    }
    const req = requirementsOf(c, m);
    const missing = [...req].filter((r) => !caps.has(r));
    const row = { goal, title: c.title, focus: m?.focus ?? null,
      requires: [...req], priority: focusRank[m?.focus] ?? 2 };
    if (missing.length) skipped.push({ ...row, why: `missing capability: ${missing.join(', ')}` });
    else matched.push(row);
  }
  matched.sort((a, b) => a.priority - b.priority || a.goal - b.goal);
  return { matched, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const asOperator = args.includes('--as') && args[args.indexOf('--as') + 1] === 'operator';
  const capsIdx = args.indexOf('--capabilities');
  const caps = capsIdx > -1
    ? new Set(args[capsIdx + 1].split(','))
    : probeCapabilities();

  const path = resolve(ROOT, 'state/facts.jsonl');
  if (!existsSync(path)) { console.error('no state/facts.jsonl — run `node src/tick.mjs` first'); process.exit(2); }
  const store = new FactStore(path);
  const classification = fold(store.all());
  const meta = new Map();
  const metaPath = resolve(ROOT, 'state/meta.json');
  if (existsSync(metaPath)) {
    for (const m of JSON.parse(readFileSync(metaPath, 'utf8'))) meta.set(m.number, m);
  }
  const hystPath = resolve(ROOT, 'state/hysteresis.json');
  const hyst = existsSync(hystPath) ? JSON.parse(readFileSync(hystPath, 'utf8')).goals : {};

  if (asOperator) {
    const acts = operatorActions(classification, meta, store.all());
    console.log(`# Operator-actionable (${acts.length})\n`);
    for (const a of acts.sort((x, y) => (y.overdue ? 1 : 0) - (x.overdue ? 1 : 0) || x.goal - y.goal)) {
      console.log(`- #${a.goal} ${a.title.slice(0, 70)}${a.overdue ? ' ⚠ overdue' : ''}`);
      console.log(`  ${a.kind} — via: ${a.via.join(' | ')}`);
    }
    process.exit(0);
  }

  console.log(`capabilities: ${[...caps].sort().join(', ')}\n`);
  const { matched, skipped } = match(classification, meta, caps, hyst);
  console.log(`# Matched (${matched.length})\n`);
  for (const r of matched) {
    console.log(`- #${r.goal} ${r.title.slice(0, 70)}${r.focus ? ` [${r.focus}]` : ''}` +
      `${r.requires.length ? ` (requires: ${r.requires.join(', ')})` : ''}`);
  }
  if (args.includes('--all') && skipped.length) {
    console.log(`\n# Skipped (${skipped.length})\n`);
    for (const r of skipped) console.log(`- #${r.goal} ${r.title.slice(0, 70)} — ${r.why}`);
  }
}
