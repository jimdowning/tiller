// sense/checks.mjs — mechanical validity sensors. A sensor turns a command's
// result into a validity-verdict fact; the fact is keyed by the INPUT HASH of
// the files it judged, so an unchanged input never re-runs and never
// duplicates, and an edit yields a fresh verdict that supersedes by fold
// order.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gateApplies } from '../gates.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

function runAllium(commands, file, repoRoot) {
  const counts = {};
  for (const cmd of commands) {
    let out;
    try {
      out = execFileSync(cmd[0], [...cmd.slice(1), file],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      // non-zero exit still produces JSON diagnostics on stdout when possible
      out = e.stdout?.toString() ?? '';
      if (!out) return { error: `sensor command failed: ${cmd.join(' ')} ${file}` };
    }
    try {
      for (const d of JSON.parse(out).diagnostics ?? []) {
        counts[d.severity] = (counts[d.severity] ?? 0) + 1;
      }
    } catch {
      return { error: `unparseable sensor output: ${cmd.join(' ')} ${file}` };
    }
  }
  return { counts };
}

/**
 * Run the spec-check sensor for every goal the gate applies to.
 * Emits validity-verdict facts (source:'sensor') for (goal, cited-spec-set)
 * pairs whose input hash has no verdict in the store yet.
 */
export function specCheckFacts({ gate, sensor, classification, meta, existingKeys, repoRoot, nowTs }) {
  const out = [];
  const fileCache = new Map(); // file -> {hash, counts|error}
  const citeRe = new RegExp(gate.appliesWhen.bodyCites, 'gi');

  for (const [goal, c] of classification) {
    if (c.bucket === 'done' || c.goalType === 'external') continue;
    const m = meta.get(goal);
    if (!m?.body) continue;
    const cited = [...new Set([...m.body.matchAll(citeRe)].map((x) => x[0]))]
      .filter((p) => existsSync(resolve(repoRoot, p)));
    if (!cited.length) continue;

    const inputHash = sha(cited.map((p) => readFileSync(resolve(repoRoot, p), 'utf8')).join('\0'));
    const key = `vv:${gate.requires.artifact}:${goal}:${inputHash}`;
    if (existingKeys.has(key)) continue; // this exact input already judged

    let total = {};
    let error = null;
    for (const p of cited) {
      if (!fileCache.has(p)) fileCache.set(p, runAllium(sensor.commands, p, repoRoot));
      const r = fileCache.get(p);
      if (r.error) { error = r.error; break; }
      for (const [sev, n] of Object.entries(r.counts)) total[sev] = (total[sev] ?? 0) + n;
    }
    if (error) {
      out.push({ ts: nowTs, kind: 'validity-verdict', goal, artifact: gate.requires.artifact,
        verdict: 'error', source: 'sensor', inputHash, note: error, key });
      continue;
    }
    total = Object.fromEntries(Object.entries(total).sort()); // stable detail strings
    const failing = (sensor.failOn ?? ['error', 'warning'])
      .reduce((n, sev) => n + (total[sev] ?? 0), 0);
    out.push({ ts: nowTs, kind: 'validity-verdict', goal, artifact: gate.requires.artifact,
      verdict: failing === 0 ? 'pass' : 'fail', source: 'sensor',
      inputHash, counts: total, files: cited, key });
  }
  return out;
}

/**
 * Generic command sensor: pass/fail by exit code.
 *
 * Sensor shape: { kind: 'command', command: ['node', 'test/fuzz.mjs', '5000'],
 * inputs: ['src/classify.mjs', ...] }. The verdict is keyed by the input hash
 * of the sensor's DECLARED input files (the files whose change should force a
 * re-run), so an unchanged input never re-runs; the command executes at most
 * once per tick and its verdict is fanned out to every goal the gate applies
 * to at that hash.
 */
export function commandCheckFacts({ gate, sensor, classification, meta, existingKeys, repoRoot, nowTs }) {
  const out = [];
  const inputs = (sensor.inputs ?? []).filter((p) => existsSync(resolve(repoRoot, p)));
  if (!inputs.length) return out;
  const inputHash = sha(inputs.map((p) => readFileSync(resolve(repoRoot, p), 'utf8')).join('\0'));

  let run = null; // lazy: only execute if some applicable goal lacks a verdict
  const runOnce = () => {
    if (run) return run;
    try {
      execFileSync(sensor.command[0], sensor.command.slice(1),
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: 'pipe' });
      run = { verdict: 'pass' };
    } catch (e) {
      run = e.status != null
        ? { verdict: 'fail', note: `exit ${e.status}: ${sensor.command.join(' ')}` }
        : { verdict: 'error', note: `sensor command failed to run: ${sensor.command.join(' ')}` };
    }
    return run;
  };

  for (const [goal, c] of classification) {
    if (c.bucket === 'done' || c.goalType === 'external') continue;
    if (!gateApplies(gate, c, meta.get(goal))) continue;
    const key = `vv:${gate.requires.artifact}:${goal}:${inputHash}`;
    if (existingKeys.has(key)) continue; // this exact input already judged
    const r = runOnce();
    out.push({ ts: nowTs, kind: 'validity-verdict', goal, artifact: gate.requires.artifact,
      verdict: r.verdict, source: 'sensor', inputHash, files: inputs,
      ...(r.note ? { note: r.note } : {}), key });
  }
  return out;
}
