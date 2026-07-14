#!/usr/bin/env node
// diagram.mjs — render each goal type's workflow (stages + situational gates)
// as mermaid, and maintain a marked section in the project README.
//
//   node src/diagram.mjs                    print the mermaid section to stdout
//   node src/diagram.mjs --write [README]   rewrite the marked section in place
//   node src/diagram.mjs --check [README]   exit non-zero if the section is stale
//
// Pure functions take config as arguments and import no config at module load
// (hermetic tests); only main() dynamically imports ./config.mjs + ./templates.mjs.
// The graph model (nodes + predecessor edges) is ADR-0001-shaped: today it is
// populated from the linear `stages` list + `GATES`; when a goal type carries
// explicit nodes-with-predecessors, only this adapter changes.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Goal-type render order: delivery first, then remaining types in object order.
const GOAL_TYPE_ORDER = ['delivery'];

export function normalizeRipe(r) {
  if (r && (Array.isArray(r.labels) || Array.isArray(r.labelPrefixes))) {
    return { labels: r.labels ?? [], labelPrefixes: r.labelPrefixes ?? [] };
  }
  return { labels: [], labelPrefixes: [] };
}

// The stage gates + the ripeness precondition attach to: the stage literally
// named 'ripe' if present, else the first non-initial stage (or the only stage).
export function ripeStageId(stages) {
  if (stages.includes('ripe')) return 'ripe';
  return stages[1] ?? stages[0] ?? null;
}

export function gateAppliesToType(gate, goalType) {
  const t = gate.appliesWhen?.goalType;
  return !t || t === goalType;
}

export function gateSituation(gate) {
  const w = gate.appliesWhen ?? {};
  const parts = [];
  if (w.bodyCites) parts.push(`cites ${w.bodyCites}`);
  if (w.labelsInclude) parts.push(`label ${w.labelsInclude}`);
  return parts.length ? parts.join(' & ') : 'always';
}

export function buildWorkflows({ goalTypes, deliveryTemplate, gates }) {
  const order = [
    ...GOAL_TYPE_ORDER.filter((k) => k in goalTypes),
    ...Object.keys(goalTypes).filter((k) => !GOAL_TYPE_ORDER.includes(k)),
  ];
  return order.map((goalType) => {
    const isDelivery = goalType === 'delivery';
    const stages = isDelivery ? deliveryTemplate.stages : goalTypes[goalType].stages;
    const ripeRequires = normalizeRipe(
      isDelivery ? deliveryTemplate.ripeRequires : goalTypes[goalType].ripeRequires,
    );
    const nodes = stages.map((s, i) => ({
      id: s, kind: 'stage', label: s, preds: i > 0 ? [stages[i - 1]] : [],
    }));
    for (const g of gates) {
      if (!gateAppliesToType(g, goalType)) continue;
      nodes.push({
        id: g.id, kind: 'gate', label: g.id, preds: [],
        gate: {
          situation: gateSituation(g),
          authority: g.authority,
          artifact: g.requires?.artifact,
          mode: g.mode,
        },
      });
    }
    return { goalType, nodes, ripeStageId: ripeStageId(stages), ripeRequires };
  });
}

// --- mermaid rendering ------------------------------------------------------

const sanitize = (id) => id.replace(/[^A-Za-z0-9]/g, '_');
// Mermaid quoted-label safety: drop backslashes, downgrade double quotes.
const esc = (s) => String(s).replace(/\\/g, '').replace(/"/g, "'");

export function ripeLabel(ripeRequires) {
  const parts = [];
  for (const l of ripeRequires.labels) parts.push(`label '${l}'`);
  for (const p of ripeRequires.labelPrefixes) parts.push(`label ${p}*`);
  return parts.length ? `requires ${parts.join(' + ')}` : null;
}

export function renderWorkflow(wf) {
  const L = ['```mermaid', 'graph LR'];
  L.push('  classDef gate fill:#fff,stroke:#999,stroke-dasharray:4 3;');
  L.push('  classDef enforce stroke:#c00,stroke-width:2px;');
  const stages = wf.nodes.filter((n) => n.kind === 'stage');
  const gates = wf.nodes.filter((n) => n.kind === 'gate');
  const rl = ripeLabel(wf.ripeRequires);

  for (const s of stages) L.push(`  s_${sanitize(s.id)}("${esc(s.label)}")`);
  for (const s of stages) {
    for (const p of s.preds) {
      const label = s.id === wf.ripeStageId && rl ? `|${esc(rl)}|` : '';
      L.push(`  s_${sanitize(p)} -->${label} s_${sanitize(s.id)}`);
    }
  }
  for (const g of gates) {
    const gid = `g_${sanitize(g.id)}`;
    const meta = `${g.gate.authority} · ${g.gate.artifact} · ${g.gate.mode}`;
    L.push(`  ${gid}{{"${esc(g.label)}<br/>when ${esc(g.gate.situation)}<br/>${esc(meta)}"}}`);
    if (wf.ripeStageId) L.push(`  ${gid} -.gate.-> s_${sanitize(wf.ripeStageId)}`);
    L.push(`  class ${gid} gate${g.gate.mode === 'enforce' ? ',enforce' : ''}`);
  }
  L.push('```');
  return L.join('\n');
}

export function renderSection(workflows) {
  const L = [];
  for (const wf of workflows) {
    L.push(`### ${wf.goalType}`, '', renderWorkflow(wf), '');
  }
  while (L.length && L[L.length - 1] === '') L.pop();
  return L.join('\n');
}

// --- README section (marker-fenced, idempotent) -----------------------------

export const START = '<!-- tiller:workflows:start -->';
export const END = '<!-- tiller:workflows:end -->';

function region(readme) {
  const si = readme.indexOf(START);
  const ei = readme.indexOf(END);
  if (si === -1 || ei === -1 || ei < si) return null;
  return { si, ei };
}

export function currentSection(readme) {
  const r = region(readme);
  return r ? readme.slice(r.si + START.length, r.ei) : null;
}

export function isInSync(readme, body) {
  return currentSection(readme) === `\n${body}\n`;
}

export function replaceSection(readme, body) {
  const r = region(readme);
  if (!r) {
    throw new Error(
      `README markers not found. Add a "## Workflows" section containing exactly:\n` +
      `${START}\n${END}\nthen re-run --write.`,
    );
  }
  const before = readme.slice(0, r.si + START.length);
  const after = readme.slice(r.ei);
  return `${before}\n${body}\n${after}`;
}

// --- CLI --------------------------------------------------------------------

export async function main(argv) {
  const { DELIVERY_TEMPLATE, GATES } = await import('./config.mjs');
  const { GOAL_TYPES } = await import('./templates.mjs');
  const workflows = buildWorkflows({
    goalTypes: GOAL_TYPES, deliveryTemplate: DELIVERY_TEMPLATE, gates: GATES,
  });
  const body = renderSection(workflows);

  const mode = argv[0];
  if (mode === '--write' || mode === '--check') {
    const path = resolve(argv[1] ?? 'README.md');
    const readme = readFileSync(path, 'utf8');
    if (mode === '--check') {
      if (isInSync(readme, body)) { console.log('workflow diagrams in sync'); return 0; }
      console.error('README workflow diagrams are STALE — run: node src/diagram.mjs --write README.md');
      return 1;
    }
    const next = replaceSection(readme, body);
    if (next === readme) { console.log(`${path} already in sync`); return 0; }
    writeFileSync(path, next);
    console.log(`updated ${path}`);
    return 0;
  }
  console.log(`${START}\n${body}\n${END}`);
  return 0;
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
