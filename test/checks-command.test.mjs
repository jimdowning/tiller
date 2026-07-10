// commandCheckFacts — the generic exit-code sensor (tiller#1): a gate's
// verdict produced by running a configured command, keyed by the input hash
// of the sensor's declared files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandCheckFacts } from '../src/sense/checks.mjs';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

const GATE = {
  id: 'classifier-fuzz',
  mode: 'shadow',
  authority: 'sensor',
  appliesWhen: { goalType: 'delivery', bodyCites: 'src/classify\\.mjs' },
  requires: { artifact: 'fuzz-run' },
};

const sensor = (argv) => ({
  kind: 'command',
  command: argv,
  inputs: ['src/schema.mjs'], // small, real file — hash input
});

const NOW = '2026-07-10T00:00:00Z';
const citing = { bucket: 'ripe', goalType: 'delivery', title: 't' };
const run = (argv, { classification, meta, existingKeys = new Set() }) =>
  commandCheckFacts({ gate: GATE, sensor: sensor(argv), classification, meta,
    existingKeys, repoRoot: REPO_ROOT, nowTs: NOW });

test('exit-0 command yields a pass verdict for every applicable goal', () => {
  const classification = new Map([[1, citing], [2, citing], [3, citing]]);
  const meta = new Map([
    [1, { body: 'touches src/classify.mjs' }],
    [2, { body: 'touches src/classify.mjs too' }],
    [3, { body: 'unrelated docs change' }], // gate does not apply
  ]);
  const facts = run(['node', '-e', 'process.exit(0)'], { classification, meta });
  assert.equal(facts.length, 2);
  for (const f of facts) {
    assert.equal(f.kind, 'validity-verdict');
    assert.equal(f.artifact, 'fuzz-run');
    assert.equal(f.verdict, 'pass');
    assert.equal(f.source, 'sensor');
    assert.ok(f.inputHash);
    assert.ok(f.key.startsWith(`vv:fuzz-run:${f.goal}:`));
  }
  // same input hash for both goals — one command run fans out
  assert.equal(facts[0].inputHash, facts[1].inputHash);
});

test('non-zero exit yields a fail verdict (never unparks — disjunctFires requires pass)', () => {
  const classification = new Map([[1, citing]]);
  const meta = new Map([[1, { body: 'src/classify.mjs' }]]);
  const facts = run(['node', '-e', 'process.exit(3)'], { classification, meta });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].verdict, 'fail');
  assert.match(facts[0].note, /exit 3/);
});

test('an already-judged input hash is skipped without running the command', () => {
  const classification = new Map([[1, citing]]);
  const meta = new Map([[1, { body: 'src/classify.mjs' }]]);
  // learn the key from a first pass, then re-run with it pre-existing and a
  // command that would FAIL if executed — no facts means no execution
  const [first] = run(['node', '-e', 'process.exit(0)'], { classification, meta });
  const facts = run(['node', '-e', 'process.exit(1)'],
    { classification, meta, existingKeys: new Set([first.key]) });
  assert.equal(facts.length, 0);
});

test('no applicable goal — the command never runs, no facts', () => {
  const classification = new Map([
    [1, { ...citing, bucket: 'done' }], // done goals are skipped
    [2, { ...citing, goalType: 'journey' }], // wrong goal type
  ]);
  const meta = new Map([[1, { body: 'src/classify.mjs' }], [2, { body: 'src/classify.mjs' }]]);
  const facts = run(['node', '-e', 'process.exit(1)'], { classification, meta });
  assert.equal(facts.length, 0);
});

test('missing input files produce no verdict (nothing to key on)', () => {
  const classification = new Map([[1, citing]]);
  const meta = new Map([[1, { body: 'src/classify.mjs' }]]);
  const facts = commandCheckFacts({
    gate: GATE,
    sensor: { kind: 'command', command: ['node', '-e', 'process.exit(0)'], inputs: ['no/such/file.mjs'] },
    classification, meta, existingKeys: new Set(), repoRoot: REPO_ROOT, nowTs: NOW,
  });
  assert.equal(facts.length, 0);
});
