import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflows } from '../src/diagram.mjs';

const FIXTURE = {
  goalTypes: {
    delivery: { stages: ['x', 'y'], ripeRequires: { conditioned: true } },
    review: { stages: ['queued', 'ripe', 'closed'], ripeRequires: {} },
  },
  deliveryTemplate: {
    stages: ['shaped', 'ripe', 'merged'],
    ripeRequires: { labels: ['shaped'], labelPrefixes: [] },
  },
  gates: [
    { id: 'fuzz', mode: 'shadow', authority: 'sensor',
      appliesWhen: { goalType: 'delivery', bodyCites: 'src/x.mjs' }, requires: { artifact: 'fuzz-run' } },
    { id: 'signoff', mode: 'enforce', authority: 'operator',
      appliesWhen: { goalType: 'review' }, requires: { artifact: 'signoff' } },
    { id: 'global', mode: 'shadow', authority: 'sensor',
      appliesWhen: {}, requires: { artifact: 'g' } },
  ],
};

test('buildWorkflows: delivery first, uses deliveryTemplate stages', () => {
  const wfs = buildWorkflows(FIXTURE);
  assert.deepEqual(wfs.map((w) => w.goalType), ['delivery', 'review']);
  const delivery = wfs[0];
  assert.deepEqual(
    delivery.nodes.filter((n) => n.kind === 'stage').map((n) => n.id),
    ['shaped', 'ripe', 'merged'],
  );
  assert.equal(delivery.ripeStageId, 'ripe');
  assert.deepEqual(delivery.ripeRequires, { labels: ['shaped'], labelPrefixes: [] });
});

test('buildWorkflows: stage predecessors form a chain', () => {
  const delivery = buildWorkflows(FIXTURE)[0];
  const stages = delivery.nodes.filter((n) => n.kind === 'stage');
  assert.deepEqual(stages[0].preds, []);
  assert.deepEqual(stages[1].preds, ['shaped']);
  assert.deepEqual(stages[2].preds, ['ripe']);
});

test('buildWorkflows: gates attach only to matching goal types', () => {
  const [delivery, review] = buildWorkflows(FIXTURE);
  const gateIds = (w) => w.nodes.filter((n) => n.kind === 'gate').map((n) => n.id);
  assert.deepEqual(gateIds(delivery), ['fuzz', 'global']);
  assert.deepEqual(gateIds(review), ['signoff', 'global']);
});

test('buildWorkflows: gate node carries situation + authority + artifact + mode', () => {
  const delivery = buildWorkflows(FIXTURE)[0];
  const fuzz = delivery.nodes.find((n) => n.id === 'fuzz');
  assert.equal(fuzz.kind, 'gate');
  assert.deepEqual(fuzz.gate, {
    situation: 'cites src/x.mjs', authority: 'sensor', artifact: 'fuzz-run', mode: 'shadow',
  });
});

test('buildWorkflows: review ripeStageId resolves to the "ripe" stage', () => {
  const review = buildWorkflows(FIXTURE)[1];
  assert.equal(review.ripeStageId, 'ripe');
  assert.deepEqual(review.ripeRequires, { labels: [], labelPrefixes: [] });
});

import { renderWorkflow, renderSection, ripeLabel } from '../src/diagram.mjs';

test('ripeLabel: renders labels and prefixes, null when empty', () => {
  assert.equal(ripeLabel({ labels: ['shaped'], labelPrefixes: [] }), "requires label 'shaped'");
  assert.equal(ripeLabel({ labels: [], labelPrefixes: ['blast-radius:'] }), 'requires label blast-radius:*');
  assert.equal(ripeLabel({ labels: [], labelPrefixes: [] }), null);
});

test('renderWorkflow: fenced mermaid graph with stage chain', () => {
  const delivery = buildWorkflows(FIXTURE)[0];
  const out = renderWorkflow(delivery);
  assert.match(out, /^```mermaid\ngraph LR/);
  assert.match(out, /```$/);
  assert.ok(out.includes('s_shaped("shaped")'));
  // precondition on the edge into the ripe stage:
  assert.ok(out.includes("s_shaped -->|requires label 'shaped'| s_ripe"));
  assert.ok(out.includes('s_ripe --> s_merged'));
});

test('renderWorkflow: gate nodes are hexagons dashed into the ripe stage', () => {
  const delivery = buildWorkflows(FIXTURE)[0];
  const out = renderWorkflow(delivery);
  assert.ok(out.includes('g_fuzz{{"fuzz<br/>when cites src/x.mjs<br/>sensor · fuzz-run · shadow"}}'));
  assert.ok(out.includes('g_fuzz -.gate.-> s_ripe'));
  assert.ok(out.includes('class g_fuzz gate'));
});

test('renderWorkflow: enforce gates carry the enforce class', () => {
  const review = buildWorkflows(FIXTURE)[1];
  const out = renderWorkflow(review);
  assert.ok(out.includes('class g_signoff gate,enforce'));
});

test('renderSection: one subheading per goal type, delivery first, trimmed', () => {
  const section = renderSection(buildWorkflows(FIXTURE));
  assert.ok(section.startsWith('### delivery\n'));
  assert.ok(section.includes('### review\n'));
  assert.ok(!section.endsWith('\n'));
});
