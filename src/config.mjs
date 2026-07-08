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
// When TILLER_CONFIG is unset, behaviour is exactly the historical default:
// ../engine.config.mjs, state/ and snapshots/ under the engine root, and a
// repo root three levels up (the in-strengthsys layout the engine grew up in).
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.TILLER_CONFIG
  ? resolve(process.env.TILLER_CONFIG)
  : null;
const mod = configPath
  ? await import(pathToFileURL(configPath).href)
  : await import('../engine.config.mjs');
const base = configPath ? dirname(configPath) : ENGINE_ROOT;

export const GATES = mod.GATES;
export const SENSORS = mod.SENSORS;
export const STATE_DIR = resolve(base, mod.stateDir ?? 'state');
export const SNAP_DIR = resolve(base, mod.snapshotDir ?? 'snapshots');
export const REPO_ROOT = configPath
  ? resolve(base, mod.repoRoot ?? '.')
  : resolve(ENGINE_ROOT, '../../..');
