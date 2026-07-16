// Incremental sensing (#6): the per-item drill-down is watermarked on
// updated_at — a warm tick over an unchanged repo drills nothing, an item
// whose updated_at advanced drills alone, and --full drills everything.
// External refs carried by SKIPPED items keep being re-resolved (a dep that
// closed since last tick must still read as done).
//
// TILLER_CONFIG points at a temp config BEFORE tick.mjs is imported (the
// sense-guard.test.mjs pattern); node --test isolates per-file processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tiller-incr-sense-'));
writeFileSync(join(dir, 'cfg.mjs'), [
  'export const GATES = [];',
  'export const SENSORS = {};',
  "export const stateDir = 'state';",
  "export const snapshotDir = 'snapshots';",
  "export const repoRoot = '.';",
].join('\n') + '\n');
process.env.TILLER_CONFIG = join(dir, 'cfg.mjs');

const { runTick, shouldDrillItem, itemRefs } = await import('../src/tick.mjs');

const WM = join(dir, 'state', 'sense-watermarks.json');

const item = (n, updatedAt, over = {}) => ({
  number: n, isPR: false, updatedAt, title: `goal ${n}`, body: '', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', closedAt: null,
  labels: [], events: [], comments: [], ...over,
});

/** Sensor honouring shouldDrill, recording which items it drilled. */
function watermarkSensor(items, resolveLog = []) {
  const drilledNumbers = [];
  return {
    drilledNumbers,
    repo: 'test/repo',
    fetch: ({ shouldDrill }) => {
      const drilled = [];
      const skipped = [];
      for (const it of items) {
        const head = { number: it.number, isPR: it.isPR, updatedAt: it.updatedAt };
        if (shouldDrill(head)) { drilledNumbers.push(it.number); drilled.push(it); }
        else skipped.push(head);
      }
      return { drilled, skipped };
    },
    resolveRefs: (referenced, known) => {
      resolveLog.push([...referenced].sort((a, b) => a - b));
      const out = new Map();
      for (const n of referenced) {
        if (!known.has(n)) {
          out.set(n, { state: 'closed', title: `ext ${n}`,
            closedAt: '2026-07-02T00:00:00Z', createdAt: '2026-07-01T00:00:00Z' });
        }
      }
      return out;
    },
  };
}

// ---- unit: the drill decision ------------------------------------------------

test('shouldDrillItem: no previous watermark always drills', () => {
  assert.equal(shouldDrillItem({ number: 1, isPR: false, updatedAt: 'T1' }, {}, new Map()), true);
});

test('shouldDrillItem: unchanged updated_at skips', () => {
  const wm = { 1: { updatedAt: 'T1', refs: [] } };
  assert.equal(
    shouldDrillItem({ number: 1, isPR: false, updatedAt: 'T1' }, wm, new Map([[1, {}]])),
    false);
});

test('shouldDrillItem: advanced updated_at drills', () => {
  const wm = { 1: { updatedAt: 'T1', refs: [] } };
  assert.equal(
    shouldDrillItem({ number: 1, isPR: false, updatedAt: 'T2' }, wm, new Map([[1, {}]])),
    true);
});

test('shouldDrillItem: an issue missing from goal meta re-drills (self-heal)', () => {
  const wm = { 1: { updatedAt: 'T1', refs: [] } };
  assert.equal(shouldDrillItem({ number: 1, isPR: false, updatedAt: 'T1' }, wm, new Map()), true);
});

test('shouldDrillItem: missing updatedAt on either side drills (no trustable watermark)', () => {
  assert.equal(shouldDrillItem({ number: 1, isPR: false, updatedAt: null },
    { 1: { updatedAt: 'T1', refs: [] } }, new Map([[1, {}]])), true);
  assert.equal(shouldDrillItem({ number: 1, isPR: false, updatedAt: 'T1' },
    { 1: { updatedAt: null, refs: [] } }, new Map([[1, {}]])), true);
});

test('itemRefs: collects #N over title, body, and comments; drops self-refs', () => {
  const refs = itemRefs({ number: 7, title: 'fix #5', body: 'blocked by #9 and #7',
    comments: [{ body: 'see #5 and #12' }] });
  assert.deepEqual(refs, [5, 9, 12]);
});

// ---- integration: warm ticks skip, changed items drill -----------------------

test('tick: warm no-change tick drills nothing; changed item drills alone', async () => {
  const resolveLog = [];
  const items = [
    item(1, '2026-07-05T00:00:00Z', { labels: ['shaped'] }),
    item(2, '2026-07-05T00:00:00Z', { body: 'depends on #99' }),
    item(3, '2026-07-05T00:00:00Z'),
  ];

  // tick 1: cold — everything drills, watermarks written
  const s1 = watermarkSensor(items, resolveLog);
  await runTick({ sense: s1 });
  assert.deepEqual(s1.drilledNumbers, [1, 2, 3]);
  const wm1 = JSON.parse(readFileSync(WM, 'utf8'));
  assert.deepEqual(Object.keys(wm1).sort(), ['1', '2', '3']);
  assert.deepEqual(wm1[2].refs, [99]);

  // tick 2: warm, nothing changed — zero drills; #99 still re-resolved via the
  // SKIPPED item's stored refs (dep closure must keep reading as done)
  const s2 = watermarkSensor(items, resolveLog);
  const snap2 = await runTick({ sense: s2 });
  assert.deepEqual(s2.drilledNumbers, []);
  assert.ok(resolveLog.at(-1).includes(99), 'skipped item refs still resolved');
  // meta survived the skip: all three issues still classified
  const metaArr = JSON.parse(readFileSync(join(dir, 'state', 'meta.json'), 'utf8'));
  assert.deepEqual(metaArr.map((m) => m.number).sort(), [1, 2, 3]);
  assert.ok(snap2.counts.ripe + snap2.counts.parked + snap2.counts.waiting >= 3);

  // tick 3: only #2's updated_at advanced — it drills alone
  const bumped = [items[0], { ...items[1], updatedAt: '2026-07-06T00:00:00Z' }, items[2]];
  const s3 = watermarkSensor(bumped, resolveLog);
  await runTick({ sense: s3 });
  assert.deepEqual(s3.drilledNumbers, [2]);
  const wm3 = JSON.parse(readFileSync(WM, 'utf8'));
  assert.equal(wm3[2].updatedAt, '2026-07-06T00:00:00Z');

  // tick 4: --full overrides the watermark — everything drills
  const s4 = watermarkSensor(bumped, resolveLog);
  await runTick({ sense: s4, fullSense: true });
  assert.deepEqual(s4.drilledNumbers, [1, 2, 3]);
});

test('tick: an item leaving the open set falls out of the watermarks', async () => {
  assert.ok(existsSync(WM));
  const remaining = [item(1, '2026-07-05T00:00:00Z', { labels: ['shaped'] }),
    item(2, '2026-07-06T00:00:00Z', { body: 'depends on #99' })];
  await runTick({ sense: watermarkSensor(remaining), acceptShrink: true });
  const wm = JSON.parse(readFileSync(WM, 'utf8'));
  assert.deepEqual(Object.keys(wm).sort(), ['1', '2']);
});
