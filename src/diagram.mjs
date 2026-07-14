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
