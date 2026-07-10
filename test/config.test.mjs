// TILLER_CONFIG resolution (#5): a relative path resolves against the
// INVOKING cwd (INIT_CWD, then PWD, then the process cwd) — never silently
// against wherever the engine process happens to be spawned.
//
// TILLER_CONFIG is unset here, so importing config.mjs falls back to the
// default engine.config.mjs; only the exported resolver is exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

delete process.env.TILLER_CONFIG;
const { resolveConfigPath } = await import('../src/config.mjs');

const invokerDir = mkdtempSync(join(tmpdir(), 'tiller-invoker-'));
const engineDir = mkdtempSync(join(tmpdir(), 'tiller-engine-'));
const scriptDir = mkdtempSync(join(tmpdir(), 'tiller-script-'));
writeFileSync(join(invokerDir, 'tiller.config.mjs'), 'export const GATES = [];\n');

test('unset TILLER_CONFIG resolves to null (default config path)', () => {
  assert.equal(resolveConfigPath(undefined, { env: {}, cwd: engineDir }), null);
  assert.equal(resolveConfigPath('', { env: {}, cwd: engineDir }), null);
});

test('absolute path passes through untouched', () => {
  const abs = join(invokerDir, 'tiller.config.mjs');
  assert.equal(resolveConfigPath(abs, { env: {}, cwd: engineDir }), abs);
});

test('missing absolute path throws loudly', () => {
  assert.throws(
    () => resolveConfigPath(join(invokerDir, 'nope.mjs'), { env: {}, cwd: engineDir }),
    /does not exist/,
  );
});

test('relative path resolves against PWD (invoking cwd), not the spawn cwd', () => {
  // the parity-harness shape: spawned with cwd=engine dir, PWD still the
  // shell's cwd where tiller.config.mjs actually lives
  assert.equal(
    resolveConfigPath('./tiller.config.mjs', { env: { PWD: invokerDir }, cwd: engineDir }),
    join(invokerDir, 'tiller.config.mjs'),
  );
});

test('INIT_CWD (npm/pnpm) takes precedence over PWD', () => {
  writeFileSync(join(scriptDir, 'tiller.config.mjs'), 'export const GATES = [];\n');
  assert.equal(
    resolveConfigPath('tiller.config.mjs',
      { env: { INIT_CWD: scriptDir, PWD: invokerDir }, cwd: engineDir }),
    join(scriptDir, 'tiller.config.mjs'),
  );
});

test('falls back to the process cwd when the invoking-cwd bases miss', () => {
  assert.equal(
    resolveConfigPath('tiller.config.mjs', { env: { PWD: engineDir }, cwd: invokerDir }),
    join(invokerDir, 'tiller.config.mjs'),
  );
});

test('relative path found nowhere throws, listing the bases tried', () => {
  assert.throws(
    () => resolveConfigPath('./ghost.config.mjs', { env: { PWD: invokerDir }, cwd: engineDir }),
    (e) => e.message.includes(invokerDir) && e.message.includes(engineDir)
      && /invoking cwd/.test(e.message),
  );
});
