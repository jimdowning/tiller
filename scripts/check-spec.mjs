#!/usr/bin/env node
// scripts/check-spec.mjs — allium gate over the classifier contract spec.
//
//   node scripts/check-spec.mjs [spec/goal-liveness.allium ...]
//
// Runs `allium check` + `allium analyse` on each spec. Errors always fail.
// Warnings are RATCHETED: the spec carries WARNING_BASELINE known structural
// warnings (documentation-only entities the contract keeps for exposition);
// exceeding the baseline fails, shrinking it is called out so the baseline
// can be lowered. This is the "no-new-warnings ratchet" calibration from the
// README's shadow-gate note, applied to this repo's own spec.
import { execFileSync } from 'node:child_process';

const WARNING_BASELINE = 2; // entity Fact + value AbsenceSentinel (doc-only)

const specs = process.argv.slice(2);
if (!specs.length) specs.push('spec/goal-liveness.allium');

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
      if (warnings.length > WARNING_BASELINE) {
        console.error(`RATCHET ${spec}: ${warnings.length} warnings > baseline ${WARNING_BASELINE}:`);
        for (const d of warnings) console.error(`  ${spec}:${d.location?.line}: ${d.message}`);
        failed = true;
      } else if (warnings.length < WARNING_BASELINE) {
        console.log(`${spec}: ${warnings.length} warnings < baseline ${WARNING_BASELINE} — lower WARNING_BASELINE`);
      }
      console.log(`allium ${cmd} ${spec}: ${errors.length} errors, ${warnings.length} warnings (baseline ${WARNING_BASELINE})`);
    } else {
      console.log(`allium ${cmd} ${spec}: ${errors.length} errors`);
    }
  }
}

process.exit(failed ? 1 : 0);
