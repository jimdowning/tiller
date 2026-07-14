#!/usr/bin/env node
// heartbeat.mjs — record a liveness pulse from a loop-wrapped stream.
//
//   node src/heartbeat.mjs 123     # pulse tied to goal #123 (fires its budget unpark)
//   node src/heartbeat.mjs loop    # pulse from a named stream (dead-loop detector)
//
// Emit-side of the E0-07 dead-loop detector (tiller#8): a /loop-wrapped stream
// appends one heartbeat per iteration. `heartbeat { source }` is already
// modelled (schema.mjs) and consumed (classify.mjs) — this is the sanctioned
// appender that mints one, mirroring attest.mjs.
//
// `source` is polymorphic (matching the fuzz model, test/fuzz.mjs):
//   - a GOAL NUMBER: matches the goal key, so classify's generic unpark clears
//     that goal's `budget-exhausted` park (unpark anyOf ['heartbeat', ...]).
//   - a STREAM NAME: a liveness pulse tied to no goal — the substrate the
//     (separate, remaining-scope) absence-side timeout half watches to surface
//     a silent stream as dead.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FactStore } from './store.mjs';
import { STATE_DIR } from './config.mjs';

// Pure: build the heartbeat fact. An all-digits source becomes a Number so it
// matches numeric goal keys; anything else stays a stream-name string.
export function heartbeatFact(sourceArg, ts) {
  const source = /^\d+$/.test(String(sourceArg)) ? Number(sourceArg) : sourceArg;
  return { ts, kind: 'heartbeat', source };
}

export function main(argv) {
  const [sourceArg] = argv;
  if (!sourceArg) {
    console.error('usage: node src/heartbeat.mjs <source>   # goal number or stream name');
    return 2;
  }
  const fact = heartbeatFact(sourceArg, new Date().toISOString());
  const store = new FactStore(resolve(STATE_DIR, 'facts.jsonl'));
  const stored = store.append(fact);
  console.log(stored
    ? `recorded: heartbeat from ${fact.source}`
    : 'duplicate — already recorded');
  return 0;
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
