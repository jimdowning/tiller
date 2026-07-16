// config.mjs — resolve the engine's per-target configuration.
//
// TILLER_CONFIG (env var) points at a config .mjs carrying what
// engine.config.mjs carries (GATES, SENSORS) plus optional path exports:
//   stateDir     where the fact log / hysteresis / meta live
//   snapshotDir  where derived-plan snapshots land
//   repoRoot     the sensed repo's root (spec-check sensor cwd)
// Relative path exports resolve against the CONFIG FILE's directory, so a
// config at a target repo's root can say stateDir: '.tiller/state' and be
// robust to the caller's cwd.
//
// A relative TILLER_CONFIG value itself resolves against the INVOKING cwd
// (INIT_CWD, then PWD, then the process cwd — see resolveConfigPath), never
// implicitly against the engine directory (#5).
//
// When TILLER_CONFIG is unset, behaviour is exactly the historical default:
// ../engine.config.mjs, state/ and snapshots/ under the engine root, and a
// repo root three levels up (the in-strengthsys layout the engine grew up in).
import { resolve, dirname, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve TILLER_CONFIG to an absolute path (#5).
 *
 * A relative value resolves against the INVOKING cwd, not wherever the
 * engine process happens to run: callers routinely spawn the engine with
 * `cwd` set to the engine directory, which would silently repoint a relative
 * `TILLER_CONFIG=./tiller.config.mjs` at the wrong tree. Candidate bases are
 * tried in order — `INIT_CWD` (npm/pnpm scripts), `PWD` (the shell's cwd,
 * inherited unchanged through spawn), then the process cwd — and the first
 * base where the file exists wins. If the file exists under none of them,
 * this throws loudly rather than importing something unintended.
 */
export function resolveConfigPath(raw, { env = process.env, cwd = process.cwd() } = {}) {
  if (!raw) return null;
  if (isAbsolute(raw)) {
    if (!existsSync(raw)) {
      throw new Error(`TILLER_CONFIG points at ${raw}, which does not exist`);
    }
    return raw;
  }
  const bases = [...new Set([env.INIT_CWD, env.PWD, cwd].filter(Boolean))];
  for (const base of bases) {
    const candidate = resolve(base, raw);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `TILLER_CONFIG=${raw} not found — tried resolving against ${bases.join(', ')}. ` +
    'A relative TILLER_CONFIG resolves against the invoking cwd ' +
    '(INIT_CWD, then PWD, then the process cwd); pass an absolute path to be explicit.'
  );
}

const configPath = resolveConfigPath(process.env.TILLER_CONFIG);
const mod = configPath
  ? await import(pathToFileURL(configPath).href)
  : await import('../engine.config.mjs');
const base = configPath ? dirname(configPath) : ENGINE_ROOT;

export const GATES = mod.GATES;
export const SENSORS = mod.SENSORS;

// GitHub logins whose attestation comments may claim operator authority
// (#23). Empty by default: with no declared operators, no sensed comment can
// carry an operator-source verdict — the safe default for a repo that hasn't
// decided who its operators are.
export const OPERATORS = mod.OPERATORS ?? [];

// Per-repo delivery template (the thin-process consumer shape, tiller#1).
// A config may export DELIVERY_TEMPLATE = { stages, ripeRequires } to replace
// the engine defaults in templates.mjs — e.g. a thin repo whose whole
// ripeness contract is one `shaped` label, with no blast-radius taxonomy and
// no ceremony floor. Omitted fields keep the engine defaults, so existing
// consumers (and TILLER_CONFIG-less checkouts) are unaffected.
const { GOAL_TYPES, RIPE_REQUIRES: DEFAULT_RIPE_REQUIRES } = await import('./templates.mjs');
const overrideRipe = mod.DELIVERY_TEMPLATE?.ripeRequires;
export const DELIVERY_TEMPLATE = {
  stages: mod.DELIVERY_TEMPLATE?.stages ?? GOAL_TYPES.delivery.stages,
  ripeRequires: overrideRipe
    ? { labels: overrideRipe.labels ?? [], labelPrefixes: overrideRipe.labelPrefixes ?? [] }
    : DEFAULT_RIPE_REQUIRES,
};
export const RIPE_REQUIRES = DELIVERY_TEMPLATE.ripeRequires;

export const STATE_DIR = resolve(base, mod.stateDir ?? 'state');
export const SNAP_DIR = resolve(base, mod.snapshotDir ?? 'snapshots');
export const REPO_ROOT = configPath
  ? resolve(base, mod.repoRoot ?? '.')
  : resolve(ENGINE_ROOT, '../../..');
