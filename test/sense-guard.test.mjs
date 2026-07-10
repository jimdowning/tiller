// Guards against a degraded GitHub sense clobbering state/meta.json (#4).
//
// TILLER_CONFIG is pointed at a temp config BEFORE tick.mjs is imported, so
// the integration tests below run against a throwaway state dir. node --test
// runs each test file in its own process, so this doesn't leak anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tiller-sense-guard-'));
writeFileSync(join(dir, 'cfg.mjs'), [
  'export const GATES = [];',
  'export const SENSORS = {};',
  "export const stateDir = 'state';",
  "export const snapshotDir = 'snapshots';",
  "export const repoRoot = '.';",
].join('\n') + '\n');
process.env.TILLER_CONFIG = join(dir, 'cfg.mjs');

const { runTick, checkSensePlausibility } = await import('../src/tick.mjs');
const { collectSearchPages, DegradedSenseError } = await import('../src/sense/github.mjs');

const STATE = join(dir, 'state');
const META = join(STATE, 'meta.json');

const item = (n, over = {}) => ({
  number: n, isPR: false, title: `goal ${n}`, body: '', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', closedAt: null,
  labels: [], events: [], comments: [], ...over,
});

function seedMeta(count) {
  mkdirSync(STATE, { recursive: true });
  const entries = Array.from({ length: count }, (_, i) => ({
    number: i + 1, title: `goal ${i + 1}`, body: '', labels: [], focus: null,
  }));
  writeFileSync(META, JSON.stringify(entries, null, 2));
  return entries;
}

const sensor = (items) => ({
  repo: 'test/repo',
  fetch: () => items,
  resolveRefs: () => new Map(),
});

// ---- collectSearchPages (the incomplete_results detector) -------------------

test('collectSearchPages: clean multi-page search collects everything', () => {
  const pages = {
    1: { total_count: 150, incomplete_results: false,
      items: Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) },
    2: { total_count: 150, incomplete_results: false,
      items: Array.from({ length: 50 }, (_, i) => ({ number: 101 + i })) },
  };
  const all = collectSearchPages((p) => pages[p]);
  assert.equal(all.length, 150);
  assert.equal(all[149].number, 150);
});

test('collectSearchPages: incomplete_results throws DegradedSenseError', () => {
  assert.throws(
    () => collectSearchPages(() => ({
      total_count: 40, incomplete_results: true, items: [{ number: 1 }],
    })),
    (e) => e instanceof DegradedSenseError && /incomplete_results/.test(e.message),
  );
});

test('collectSearchPages: truncation short of total_count throws', () => {
  // one full page then the safety bound cuts pagination off
  const page = { total_count: 300, incomplete_results: false,
    items: Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) };
  assert.throws(
    () => collectSearchPages(() => page, { maxPages: 2 }),
    (e) => e instanceof DegradedSenseError && /200 of 300/.test(e.message),
  );
});

// ---- checkSensePlausibility --------------------------------------------------

test('plausibility: no previous meta is always plausible', () => {
  assert.equal(checkSensePlausibility(null, 1).ok, true);
});

test('plausibility: tiny previous sets never trip the guard', () => {
  assert.equal(checkSensePlausibility(4, 0).ok, true);
});

test('plausibility: ordinary closure churn passes', () => {
  assert.equal(checkSensePlausibility(40, 32).ok, true);
  assert.equal(checkSensePlausibility(40, 20).ok, true); // exactly at the bound
});

test('plausibility: an implausible collapse fails with a count-bearing message', () => {
  const r = checkSensePlausibility(40, 1);
  assert.equal(r.ok, false);
  assert.match(r.message, /40 -> 1/);
});

// ---- runTick integration: degraded sense must not overwrite meta ------------

test('tick: a shrunken sense fails loudly and leaves meta.json untouched', async () => {
  const before = seedMeta(10);
  await assert.rejects(
    runTick({ sense: sensor([item(1)]) }),
    (e) => e instanceof DegradedSenseError && /shrank implausibly/.test(e.message),
  );
  assert.deepEqual(JSON.parse(readFileSync(META, 'utf8')), before);
  // the guard fires before any append — no facts, no descope contradictions
  assert.equal(existsSync(join(STATE, 'facts.jsonl')), false);
});

test('tick: a sense that throws DegradedSenseError propagates, meta untouched', async () => {
  const before = seedMeta(10);
  const degraded = {
    repo: 'test/repo',
    fetch: () => { throw new DegradedSenseError('incomplete_results simulated'); },
    resolveRefs: () => new Map(),
  };
  await assert.rejects(runTick({ sense: degraded }), DegradedSenseError);
  assert.deepEqual(JSON.parse(readFileSync(META, 'utf8')), before);
});

test('tick: --accept-shrink overrides the guard and rewrites meta', async () => {
  seedMeta(10);
  const snap = await runTick({ sense: sensor([item(1)]), acceptShrink: true });
  assert.ok(snap.counts);
  const after = JSON.parse(readFileSync(META, 'utf8'));
  assert.equal(after.length, 1);
  assert.equal(after[0].number, 1);
});

test('tick: a plausible sense proceeds normally', async () => {
  seedMeta(6);
  const items = [1, 2, 3, 4, 5].map((n) => item(n));
  const snap = await runTick({ sense: sensor(items) });
  assert.equal(JSON.parse(readFileSync(META, 'utf8')).length, 5);
  assert.ok(snap.counts.parked + snap.counts.ripe + snap.counts.waiting + snap.counts.holding >= 1);
});
