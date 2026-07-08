// sense/checks.mjs — mechanical validity sensors. A sensor turns a command's
// result into a validity-verdict fact; the fact is keyed by the INPUT HASH of
// the files it judged, so an unchanged input never re-runs and never
// duplicates, and an edit yields a fresh verdict that supersedes by fold
// order.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

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
