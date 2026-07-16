// Durable attestations (#23): `tiller:attest <artifact> <pass|fail>
// [source=...] [— note]` comments become validity-verdict facts at sense
// time, with the claimed source capped by the author's authority ceiling —
// operator for logins in OPERATORS, sensor for `*[bot]`, agent otherwise.
// An over-claim is downgraded and marked, never trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, attestationFacts, authorityCeiling } from '../src/sense/translate.mjs';
import { evaluateGates } from '../src/gates.mjs';
import { fold } from '../src/classify.mjs';

const OPS = ['jim'];
const NOW = '2026-07-16T12:00:00Z';

const comment = (body, author = 'jim', ts = '2026-07-10T00:00:00Z') => ({ ts, author, body });

const issue = (over = {}) => ({
  number: 1, isPR: false, title: 'A goal', body: '', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', closedAt: null,
  labels: [], events: [], comments: [], ...over,
});

// ---- authority ceiling --------------------------------------------------------

test('ceiling: declared operator login → operator; bot → sensor; anyone else → agent', () => {
  assert.equal(authorityCeiling('jim', OPS), 'operator');
  assert.equal(authorityCeiling('github-actions[bot]', OPS), 'sensor');
  assert.equal(authorityCeiling('random-dev', OPS), 'agent');
  assert.equal(authorityCeiling(undefined, OPS), 'agent');
});

// ---- parsing -------------------------------------------------------------------

test('attest line parses: artifact, verdict, claimed source, note', () => {
  const [f] = attestationFacts(1,
    comment('tiller:attest value-clear pass source=operator — value legible now'), OPS);
  assert.deepEqual(f, {
    ts: '2026-07-10T00:00:00Z', kind: 'validity-verdict', goal: 1,
    artifact: 'value-clear', verdict: 'pass', source: 'operator',
    note: 'value legible now',
  });
});

test('source defaults to agent when unclaimed — even for an operator author', () => {
  const [f] = attestationFacts(1, comment('tiller:attest spec-present pass'), OPS);
  assert.equal(f.source, 'agent');
  assert.equal(f.downgraded, undefined);
});

test('ascii double-dash note separator also parses', () => {
  const [f] = attestationFacts(1, comment('tiller:attest arch-fit fail -- extends the wrong seam'), OPS);
  assert.equal(f.verdict, 'fail');
  assert.equal(f.note, 'extends the wrong seam');
});

test('multiple attest lines in one comment each produce a fact', () => {
  const facts = attestationFacts(1, comment(
    'tiller:attest value-clear pass source=operator\ntiller:attest arch-fit pass source=operator'), OPS);
  assert.deepEqual(facts.map((f) => f.artifact), ['value-clear', 'arch-fit']);
});

test('prose around the marker does not parse; malformed lines are ignored', () => {
  assert.equal(attestationFacts(1, comment('please tiller:attest value-clear pass'), OPS).length, 0);
  assert.equal(attestationFacts(1, comment('tiller:attest value-clear maybe'), OPS).length, 0);
});

// ---- the ceiling binds -----------------------------------------------------------

test('non-operator claiming operator is downgraded to agent and marked', () => {
  const [f] = attestationFacts(1,
    comment('tiller:attest value-clear pass source=operator', 'random-dev'), OPS);
  assert.equal(f.source, 'agent');
  assert.equal(f.claimedSource, 'operator');
  assert.equal(f.downgraded, true);
});

test('bot claiming operator is downgraded to sensor; bot claiming sensor stands', () => {
  const [over] = attestationFacts(1,
    comment('tiller:attest e2e-run pass source=operator', 'github-actions[bot]'), OPS);
  assert.equal(over.source, 'sensor');
  assert.equal(over.downgraded, true);
  const [ok] = attestationFacts(1,
    comment('tiller:attest e2e-run pass source=sensor', 'github-actions[bot]'), OPS);
  assert.equal(ok.source, 'sensor');
  assert.equal(ok.downgraded, undefined);
});

test('operator claiming agent stands as agent (claims cap, they do not float up)', () => {
  const [f] = attestationFacts(1, comment('tiller:attest spec-present pass source=agent', 'jim'), OPS);
  assert.equal(f.source, 'agent');
});

// ---- end-to-end: sensed comment satisfies an operator gate -----------------------

test('a sensed operator attest comment satisfies an operator-authority gate', () => {
  const gate = {
    id: 'value-clear', mode: 'shadow', authority: 'operator',
    appliesWhen: { goalType: 'delivery' },
    requires: { artifact: 'value-clear', source: 'operator' },
  };
  const mk = (author) => {
    const { facts, meta } = translate([issue({
      comments: [comment('tiller:attest value-clear pass source=operator', author)],
    })], new Map(), NOW, { operators: OPS });
    const classification = fold(facts);
    return evaluateGates([gate], classification, meta, facts, NOW);
  };
  const operator = mk('jim');
  assert.deepEqual(operator.met, [{ goal: 1, gate: 'value-clear' }]);
  // the SAME comment from a non-operator is downgraded and does NOT satisfy
  const impostor = mk('random-dev');
  assert.equal(impostor.met.length, 0);
  assert.match(impostor.wouldPark[0].detail, /lacks required authority/);
});

test('re-sensing the same comment is a no-op (event-timestamped identity)', () => {
  const items = [issue({
    comments: [comment('tiller:attest value-clear pass source=operator')],
  })];
  const a = translate(items, new Map(), NOW, { operators: OPS });
  const b = translate(items, new Map(), NOW, { operators: OPS });
  const va = a.facts.find((f) => f.kind === 'validity-verdict');
  const vb = b.facts.find((f) => f.kind === 'validity-verdict');
  assert.deepEqual(va, vb); // byte-identical → store content-dedup drops the re-sense
});
