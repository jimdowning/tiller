#!/usr/bin/env node
// scripts/check-spec.mjs — allium gate over the classifier contract spec.
//
//   node scripts/check-spec.mjs [spec/foo.allium ...]
//
// With no arguments, checks every spec in the spec/ tree (whole-engine
// behavioral coverage, ADR 0002). Runs `allium check` + `allium analyse` on
// each. Errors always fail.
//
// Warnings are RATCHETED per spec: WARNING_BASELINE records the known
// documentation-only warnings each spec deliberately keeps (a doc-only Fact
// vocabulary entity, an exposition-only value type); exceeding a spec's
// baseline fails, shrinking it is called out so the baseline can be lowered.
// A spec absent from the map has a baseline of 0 — new specs must be clean.
// This is the "no-new-warnings ratchet" from the README's shadow-gate note.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

// Per-spec known-warning baselines. Keyed by path; default 0.
const WARNING_BASELINE = {
  'spec/goal-liveness.allium': 2, // entity Fact + value AbsenceSentinel (doc-only)
  'spec/sensing.allium': 1,       // entity Fact (doc-only sense-boundary vocabulary)
};
const baselineFor = (spec) => WARNING_BASELINE[spec] ?? 0;

const specs = process.argv.slice(2);
if (!specs.length) {
  for (const f of readdirSync('spec').sort()) {
    if (f.endsWith('.allium')) specs.push(`spec/${f}`);
  }
}

let failed = false;
for (const spec of specs) {
  for (const cmd of ['check', 'analyse']) {
    let out;
    try {
      out = execFileSync('allium', [cmd, spec], { encoding: 'utf8' });
    } catch (e) {
      out = e.stdout?.toString() ?? '';
      if (!out) {
        console.error(`allium ${cmd} ${spec}: command failed with no output`);
        failed = true;
        continue;
      }
    }
    let diags;
    try {
      diags = JSON.parse(out).diagnostics ?? [];
    } catch {
      console.error(`allium ${cmd} ${spec}: unparseable output`);
      failed = true;
      continue;
    }
    const errors = diags.filter((d) => d.severity === 'error');
    const warnings = diags.filter((d) => d.severity === 'warning');
    for (const d of errors) {
      console.error(`ERROR ${spec}:${d.location?.line}: ${d.message}`);
    }
    if (errors.length) failed = true;
    if (cmd === 'check') {
      const baseline = baselineFor(spec);
      if (warnings.length > baseline) {
        console.error(`RATCHET ${spec}: ${warnings.length} warnings > baseline ${baseline}:`);
        for (const d of warnings) console.error(`  ${spec}:${d.location?.line}: ${d.message}`);
        failed = true;
      } else if (warnings.length < baseline) {
        console.log(`${spec}: ${warnings.length} warnings < baseline ${baseline} — lower its WARNING_BASELINE entry`);
      }
      console.log(`allium ${cmd} ${spec}: ${errors.length} errors, ${warnings.length} warnings (baseline ${baseline})`);
    } else {
      console.log(`allium ${cmd} ${spec}: ${errors.length} errors`);
    }
  }
}

process.exit(failed ? 1 : 0);
