// Per-repo DELIVERY_TEMPLATE override (tiller#1): a config may replace the
// ripeness label contract — e.g. the thin `shaped` contract this repo runs on
// itself. config.mjs resolves TILLER_CONFIG at import time, so the override
// path is exercised in a child process with the env var set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).href;

const PROBE = `
import { translate } from '${SRC}sense/translate.mjs';
import { fold } from '${SRC}classify.mjs';
import { DELIVERY_TEMPLATE } from '${SRC}config.mjs';
const issue = (over = {}) => ({
  number: 1, isPR: false, title: 'A goal', body: '', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', closedAt: null,
  labels: [], events: [], comments: [], ...over,
});
const bucketOf = (labels) => {
  const { facts } = translate([issue({ labels })], new Map(), '2026-07-10T00:00:00Z');
  return fold(facts).get(1).bucket;
};
console.log(JSON.stringify({
  stages: DELIVERY_TEMPLATE.stages,
  shaped: bucketOf(['shaped']),
  bare: bucketOf([]),
  strengthsysContract: bucketOf(['conditioned', 'blast-radius:isolated', 'reversibility:easy']),
}));
`;

const probe = (env) => JSON.parse(execFileSync(
  process.execPath, ['--input-type=module', '-e', PROBE],
  { encoding: 'utf8', env: { ...process.env, ...env } },
));

test('thin override: one `shaped` label is the whole ripeness contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiller-thin-'));
  writeFileSync(join(dir, 'thin.config.mjs'), `
export const GATES = [];
export const SENSORS = {};
export const DELIVERY_TEMPLATE = {
  stages: ['shaped', 'ripe', 'pr-open', 'merged'],
  ripeRequires: { labels: ['shaped'] }, // labelPrefixes omitted -> defaults to []
};
`);
  const out = probe({ TILLER_CONFIG: join(dir, 'thin.config.mjs') });
  assert.deepEqual(out.stages, ['shaped', 'ripe', 'pr-open', 'merged']);
  assert.equal(out.shaped, 'ripe');
  assert.equal(out.bare, 'parked');
  // the heavyweight contract means nothing under the thin template
  assert.equal(out.strengthsysContract, 'parked');
});

test('no override: the engine default contract is unchanged', () => {
  const env = { ...process.env };
  delete env.TILLER_CONFIG;
  const out = JSON.parse(execFileSync(
    process.execPath, ['--input-type=module', '-e', PROBE], { encoding: 'utf8', env },
  ));
  assert.deepEqual(out.stages, ['conditioned', 'implemented', 'reviewed', 'merged', 'verified', 'done']);
  assert.equal(out.shaped, 'parked');
  assert.equal(out.strengthsysContract, 'ripe');
});
