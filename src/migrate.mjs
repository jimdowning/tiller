#!/usr/bin/env node
// migrate.mjs — READ-ONLY migration plan: milestones → issues-only journeys.
//
//   node src/migrate.mjs > migration-plan.md
//
// Prints, for operator review, the exact `gh` commands that would express the
// current milestone structure as journey issues + labels. Executes NOTHING.
// The migration is additive and dual-run-safe: the engine already ignores
// milestones, existing skills keep reading them until repointed, and every
// step is a label/issue edit — one-click reversible. Milestones are deleted
// last, once nothing reads them.
import { execFileSync } from 'node:child_process';

const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
const repo = gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;

const milestones = gh(['api', `repos/${repo}/milestones?state=open&per_page=100`]);
const L = [`# Migration plan: milestones → issues-only journeys`, '',
  `Repo: ${repo} — generated read-only; review, then run the commands you approve.`, '',
  '## 0. One-time label taxonomy', '',
  '```bash',
  `gh label create goal:journey -c 5319e7 -d "a user journey: children declared in the body task-list" 2>/dev/null`,
  `gh label create focus:current -c b60205 -d "the active journey (was [CURRENT])" 2>/dev/null`,
  `gh label create focus:next -c d93f0b -d "the conditioning target (was [NEXT])" 2>/dev/null`,
  `gh label create po-todo -c fbca04 -d "operator decision queue (was the PO todo milestone)" 2>/dev/null`,
  '```', ''];

for (const ms of milestones) {
  const title = ms.title.replace(/\s*\[(CURRENT|NEXT)\]\s*/g, ' ').trim();
  const focus = /\[CURRENT\]/.test(ms.title) ? 'focus:current'
    : /\[NEXT\]/.test(ms.title) ? 'focus:next' : null;
  const issues = gh(['api', '-X', 'GET', 'search/issues',
    '-f', `q=repo:${repo} milestone:"${ms.title.replace(/"/g, '\\"')}" is:issue`,
    '-f', 'per_page=100', '--jq', '[.items[] | {number, title, state}]']);

  L.push(`## Milestone "${ms.title}" (${issues.length} issues)`, '');

  if (ms.title === 'PO todo') {
    // the decision inbox is a label, not a journey — its members are exits, not children
    L.push('This is the decision inbox → label its open members, no journey issue:', '', '```bash');
    for (const i of issues.filter((i) => i.state === 'open')) {
      L.push(`gh issue edit ${i.number} --add-label po-todo   # ${i.title.slice(0, 60)}`);
    }
    L.push('```', '');
    continue;
  }

  const taskList = issues
    .sort((a, b) => a.number - b.number)
    .map((i) => `- [${i.state === 'closed' ? 'x' : ' '}] #${i.number}`)
    .join('\n');
  const body = [
    `Value: ${(ms.description || '(lift the value statement from the milestone description — REVIEW ME)').trim()}`,
    '', taskList, '',
    `_Migrated from milestone "${ms.title}"${ms.due_on ? `, due ${ms.due_on.slice(0, 10)}` : ''}._`,
  ].join('\n');

  L.push('```bash');
  L.push(`gh issue create --title ${JSON.stringify(`Journey: ${title}`)} \\`);
  L.push(`  --label goal:journey${focus ? ` --label ${focus}` : ''} \\`);
  L.push(`  --body ${JSON.stringify(body)}`);
  L.push('```', '');
}

L.push('## Cutover order (after journeys exist)', '',
  '1. Engine consumers only (shadow tick, next.mjs, explain) — already issues-only.',
  '2. Repoint skills one at a time: dispatch → elaborator modes → check-completion.',
  '3. Milestones sit inert during dual-run; delete them LAST, once `grep -r milestone .claude/skills scripts` is clean.',
  '');
console.log(L.join('\n'));
