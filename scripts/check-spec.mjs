#!/usr/bin/env node
// scripts/check-spec.mjs — allium gate over the behavioral contract specs.
//
//   node scripts/check-spec.mjs [spec-dir]        (default: spec)
//
// The spec/ tree is checked as ONE SET (a directory), so cross-module
// `use "./tiller.allium"` imports resolve — a shared root module is only
// visible to the specs that import it when they are checked together. Runs
// `allium check` + `allium analyse` over the whole tree. Errors always fail.
//
// Warnings are RATCHETED per file: WARNING_BASELINE records the known
// documentation-only warnings a spec deliberately keeps (a doc-only Fact
// vocabulary entity, an exposition-only value type); exceeding a file's
// baseline fails, shrinking it is called out so the baseline can be lowered.
// A file absent from the map has a baseline of 0 — new specs must be clean.
// This is the "no-new-warnings ratchet" from the README's shadow-gate note.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

// Per-file known-warning baselines. Keyed by basename; default 0.
const WARNING_BASELINE = {
  'goal-liveness.allium': 2, // entity Fact + value AbsenceSentinel (doc-only)
  'sensing.allium': 1,       // entity Fact (doc-only sense-boundary vocabulary)
};
const baselineFor = (file) => WARNING_BASELINE[basename(file)] ?? 0;

const specDir = process.argv[2] ?? 'spec';

// A directory check emits one pretty-printed JSON document PER FILE,
// concatenated. Split them by tracking top-level brace depth (ignoring braces
// inside strings), then merge every document's diagnostics.
function parseConcatenated(text) {
  const docs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}') { if (--depth === 0) docs.push(JSON.parse(text.slice(start, i + 1))); }
  }
  return docs;
}

function run(cmd) {
  let out;
  try {
    out = execFileSync('allium', [cmd, specDir], { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout?.toString() ?? '';
    if (!out) throw new Error(`allium ${cmd} ${specDir}: command failed with no output`);
  }
  return parseConcatenated(out).flatMap((doc) => doc.diagnostics ?? []);
}

// Group diagnostics by the file they belong to (directory checks tag each).
function byFile(diags) {
  const m = new Map();
  for (const d of diags) {
    const f = d.location?.file ?? '(unknown)';
    if (!m.has(f)) m.set(f, []);
    m.get(f).push(d);
  }
  return m;
}

let failed = false;

// --- check: errors fail; warnings ratcheted per file ---------------------
const checkByFile = byFile(run('check'));
for (const [file, diags] of [...checkByFile].sort()) {
  const errors = diags.filter((d) => d.severity === 'error');
  const warnings = diags.filter((d) => d.severity === 'warning');
  for (const d of errors) console.error(`ERROR ${file}:${d.location?.line}: ${d.message}`);
  if (errors.length) failed = true;
  const baseline = baselineFor(file);
  if (warnings.length > baseline) {
    console.error(`RATCHET ${file}: ${warnings.length} warnings > baseline ${baseline}:`);
    for (const d of warnings) console.error(`  ${file}:${d.location?.line}: ${d.message}`);
    failed = true;
  } else if (warnings.length < baseline) {
    console.log(`${file}: ${warnings.length} warnings < baseline ${baseline} — lower its WARNING_BASELINE entry`);
  }
  console.log(`check ${file}: ${errors.length} errors, ${warnings.length} warnings (baseline ${baseline})`);
}

// --- analyse: errors fail ------------------------------------------------
const analyseByFile = byFile(run('analyse'));
for (const [file, diags] of [...analyseByFile].sort()) {
  const errors = diags.filter((d) => d.severity === 'error');
  for (const d of errors) console.error(`ERROR ${file}:${d.location?.line}: ${d.message}`);
  if (errors.length) failed = true;
  console.log(`analyse ${file}: ${errors.length} errors`);
}

process.exit(failed ? 1 : 0);
