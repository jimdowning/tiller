# render-workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dep `src/diagram.mjs` that renders each tiller goal type's stages + situational gates as mermaid, maintains a marked `## Workflows` section in `README.md`, and a CI gate that fails when the section drifts from config.

**Architecture:** `diagram.mjs` builds a normalized graph model (`Workflow` = nodes + predecessor edges) from the resolved config exports via a thin adapter, renders one mermaid `graph LR` per goal type, and read/writes the README section between HTML-comment markers. Pure functions take config as arguments and import no config at module load; only `main()` dynamically imports `./config.mjs` + `./templates.mjs`, so tests are hermetic. A CI job runs `--check`.

**Tech Stack:** Node 22, ES modules, zero runtime deps, `node --test`. Consistent with existing engine commands (`tick`/`explain`/`attest`/`next`).

## Global Constraints

- **Zero runtime dependencies.** Node builtins only (`node:fs`, `node:path`, `node:url`). No new `package.json` entries.
- **Tests run under `node --test 'test/*.test.mjs'`** (the existing CI `test` job glob).
- **`src/diagram.mjs` must not statically import `./config.mjs` or `./templates.mjs`** — those load config at import time; pure functions stay hermetic. `main()` imports them dynamically.
- **Deterministic output** — fixed goal-type order (`delivery` first, then config object order), config order for stages and gates. `--check` depends on this.
- **Commit style:** Conventional Commits. End each commit message body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Config source for this repo's README/CI:** `TILLER_CONFIG=./tiller.config.mjs`.

---

### Task 1: Graph-model adapter (`buildWorkflows`)

**Files:**
- Create: `src/diagram.mjs`
- Test: `test/diagram.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `buildWorkflows({ goalTypes, deliveryTemplate, gates }) -> Workflow[]`
    where `Workflow = { goalType: string, nodes: Node[], ripeStageId: string|null, ripeRequires: { labels: string[], labelPrefixes: string[] } }`
    and `Node = { id: string, kind: 'stage'|'gate', label: string, preds: string[], gate?: { situation, authority, artifact, mode } }`.
  - Helpers `normalizeRipe(r)`, `ripeStageId(stages)`, `gateAppliesToType(gate, goalType)`, `gateSituation(gate)`.

- [ ] **Step 1: Write the failing test**

Create `test/diagram.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflows } from '../src/diagram.mjs';

const FIXTURE = {
  goalTypes: {
    delivery: { stages: ['x', 'y'], ripeRequires: { conditioned: true } },
    review: { stages: ['queued', 'ripe', 'closed'], ripeRequires: {} },
  },
  deliveryTemplate: {
    stages: ['shaped', 'ripe', 'merged'],
    ripeRequires: { labels: ['shaped'], labelPrefixes: [] },
  },
  gates: [
    { id: 'fuzz', mode: 'shadow', authority: 'sensor',
      appliesWhen: { goalType: 'delivery', bodyCites: 'src/x.mjs' }, requires: { artifact: 'fuzz-run' } },
    { id: 'signoff', mode: 'enforce', authority: 'operator',
      appliesWhen: { goalType: 'review' }, requires: { artifact: 'signoff' } },
    { id: 'global', mode: 'shadow', authority: 'sensor',
      appliesWhen: {}, requires: { artifact: 'g' } },
  ],
};

test('buildWorkflows: delivery first, uses deliveryTemplate stages', () => {
  const wfs = buildWorkflows(FIXTURE);
  assert.deepEqual(wfs.map((w) => w.goalType), ['delivery', 'review']);
  const delivery = wfs[0];
  assert.deepEqual(
    delivery.nodes.filter((n) => n.kind === 'stage').map((n) => n.id),
    ['shaped', 'ripe', 'merged'],
  );
  assert.equal(delivery.ripeStageId, 'ripe');
  assert.deepEqual(delivery.ripeRequires, { labels: ['shaped'], labelPrefixes: [] });
});

test('buildWorkflows: stage predecessors form a chain', () => {
  const delivery = buildWorkflows(FIXTURE)[0];
  const stages = delivery.nodes.filter((n) => n.kind === 'stage');
  assert.deepEqual(stages[0].preds, []);
  assert.deepEqual(stages[1].preds, ['shaped']);
  assert.deepEqual(stages[2].preds, ['ripe']);
});

test('buildWorkflows: gates attach only to matching goal types', () => {
  const [delivery, review] = buildWorkflows(FIXTURE);
  const gateIds = (w) => w.nodes.filter((n) => n.kind === 'gate').map((n) => n.id);
  assert.deepEqual(gateIds(delivery), ['fuzz', 'global']);
  assert.deepEqual(gateIds(review), ['signoff', 'global']);
});

test('buildWorkflows: gate node carries situation + authority + artifact + mode', () => {
  const delivery = buildWorkflows(FIXTURE)[0];
  const fuzz = delivery.nodes.find((n) => n.id === 'fuzz');
  assert.equal(fuzz.kind, 'gate');
  assert.deepEqual(fuzz.gate, {
    situation: 'cites src/x.mjs', authority: 'sensor', artifact: 'fuzz-run', mode: 'shadow',
  });
});

test('buildWorkflows: review ripeStageId resolves to the "ripe" stage', () => {
  const review = buildWorkflows(FIXTURE)[1];
  assert.equal(review.ripeStageId, 'ripe');
  assert.deepEqual(review.ripeRequires, { labels: [], labelPrefixes: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/diagram.test.mjs`
Expected: FAIL — `Cannot find module '../src/diagram.mjs'` / `buildWorkflows is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/diagram.mjs` with the header and pure adapter (no config imports yet):

```js
#!/usr/bin/env node
// diagram.mjs — render each goal type's workflow (stages + situational gates)
// as mermaid, and maintain a marked section in the project README.
//
//   node src/diagram.mjs                    print the mermaid section to stdout
//   node src/diagram.mjs --write [README]   rewrite the marked section in place
//   node src/diagram.mjs --check [README]   exit non-zero if the section is stale
//
// Pure functions take config as arguments and import no config at module load
// (hermetic tests); only main() dynamically imports ./config.mjs + ./templates.mjs.
// The graph model (nodes + predecessor edges) is ADR-0001-shaped: today it is
// populated from the linear `stages` list + `GATES`; when a goal type carries
// explicit nodes-with-predecessors, only this adapter changes.

// Goal-type render order: delivery first, then remaining types in object order.
const GOAL_TYPE_ORDER = ['delivery'];

export function normalizeRipe(r) {
  if (r && (Array.isArray(r.labels) || Array.isArray(r.labelPrefixes))) {
    return { labels: r.labels ?? [], labelPrefixes: r.labelPrefixes ?? [] };
  }
  return { labels: [], labelPrefixes: [] };
}

// The stage gates + the ripeness precondition attach to: the stage literally
// named 'ripe' if present, else the first non-initial stage (or the only stage).
export function ripeStageId(stages) {
  if (stages.includes('ripe')) return 'ripe';
  return stages[1] ?? stages[0] ?? null;
}

export function gateAppliesToType(gate, goalType) {
  const t = gate.appliesWhen?.goalType;
  return !t || t === goalType;
}

export function gateSituation(gate) {
  const w = gate.appliesWhen ?? {};
  const parts = [];
  if (w.bodyCites) parts.push(`cites ${w.bodyCites}`);
  if (w.labelsInclude) parts.push(`label ${w.labelsInclude}`);
  return parts.length ? parts.join(' & ') : 'always';
}

export function buildWorkflows({ goalTypes, deliveryTemplate, gates }) {
  const order = [
    ...GOAL_TYPE_ORDER.filter((k) => k in goalTypes),
    ...Object.keys(goalTypes).filter((k) => !GOAL_TYPE_ORDER.includes(k)),
  ];
  return order.map((goalType) => {
    const isDelivery = goalType === 'delivery';
    const stages = isDelivery ? deliveryTemplate.stages : goalTypes[goalType].stages;
    const ripeRequires = normalizeRipe(
      isDelivery ? deliveryTemplate.ripeRequires : goalTypes[goalType].ripeRequires,
    );
    const nodes = stages.map((s, i) => ({
      id: s, kind: 'stage', label: s, preds: i > 0 ? [stages[i - 1]] : [],
    }));
    for (const g of gates) {
      if (!gateAppliesToType(g, goalType)) continue;
      nodes.push({
        id: g.id, kind: 'gate', label: g.id, preds: [],
        gate: {
          situation: gateSituation(g),
          authority: g.authority,
          artifact: g.requires?.artifact,
          mode: g.mode,
        },
      });
    }
    return { goalType, nodes, ripeStageId: ripeStageId(stages), ripeRequires };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/diagram.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/diagram.mjs test/diagram.test.mjs
git commit -m "feat(diagram): graph-model adapter over goal types + gates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Mermaid renderer (`renderWorkflow`, `renderSection`)

**Files:**
- Modify: `src/diagram.mjs`
- Test: `test/diagram.test.mjs`

**Interfaces:**
- Consumes: `Workflow[]` from `buildWorkflows` (Task 1).
- Produces:
  - `renderWorkflow(wf) -> string` (one fenced ```mermaid block).
  - `renderSection(workflows) -> string` (all goal types, `### <type>` subheadings, no leading/trailing blank lines).
  - Helpers `ripeLabel(ripeRequires) -> string|null`, plus internal `sanitize`/`esc`.

- [ ] **Step 1: Write the failing test**

Append to `test/diagram.test.mjs`:

```js
import { renderWorkflow, renderSection, ripeLabel } from '../src/diagram.mjs';

test('ripeLabel: renders labels and prefixes, null when empty', () => {
  assert.equal(ripeLabel({ labels: ['shaped'], labelPrefixes: [] }), "requires label 'shaped'");
  assert.equal(ripeLabel({ labels: [], labelPrefixes: ['blast-radius:'] }), 'requires label blast-radius:*');
  assert.equal(ripeLabel({ labels: [], labelPrefixes: [] }), null);
});

test('renderWorkflow: fenced mermaid graph with stage chain', () => {
  const delivery = buildWorkflows(FIXTURE)[0];
  const out = renderWorkflow(delivery);
  assert.match(out, /^```mermaid\ngraph LR/);
  assert.match(out, /```$/);
  assert.ok(out.includes('s_shaped("shaped")'));
  // precondition on the edge into the ripe stage:
  assert.ok(out.includes("s_shaped -->|requires label 'shaped'| s_ripe"));
  assert.ok(out.includes('s_ripe --> s_merged'));
});

test('renderWorkflow: gate nodes are hexagons dashed into the ripe stage', () => {
  const delivery = buildWorkflows(FIXTURE)[0];
  const out = renderWorkflow(delivery);
  assert.ok(out.includes('g_fuzz{{"fuzz<br/>when cites src/x.mjs<br/>sensor · fuzz-run · shadow"}}'));
  assert.ok(out.includes('g_fuzz -.gate.-> s_ripe'));
  assert.ok(out.includes('class g_fuzz gate'));
});

test('renderWorkflow: enforce gates carry the enforce class', () => {
  const review = buildWorkflows(FIXTURE)[1];
  const out = renderWorkflow(review);
  assert.ok(out.includes('class g_signoff gate,enforce'));
});

test('renderSection: one subheading per goal type, delivery first, trimmed', () => {
  const section = renderSection(buildWorkflows(FIXTURE));
  assert.ok(section.startsWith('### delivery\n'));
  assert.ok(section.includes('### review\n'));
  assert.ok(!section.endsWith('\n'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/diagram.test.mjs`
Expected: FAIL — `renderWorkflow is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/diagram.mjs` (after the adapter):

```js
// --- mermaid rendering ------------------------------------------------------

const sanitize = (id) => id.replace(/[^A-Za-z0-9]/g, '_');
// Mermaid quoted-label safety: drop backslashes, downgrade double quotes.
const esc = (s) => String(s).replace(/\\/g, '').replace(/"/g, "'");

export function ripeLabel(ripeRequires) {
  const parts = [];
  for (const l of ripeRequires.labels) parts.push(`label '${l}'`);
  for (const p of ripeRequires.labelPrefixes) parts.push(`label ${p}*`);
  return parts.length ? `requires ${parts.join(' + ')}` : null;
}

export function renderWorkflow(wf) {
  const L = ['```mermaid', 'graph LR'];
  L.push('  classDef gate fill:#fff,stroke:#999,stroke-dasharray:4 3;');
  L.push('  classDef enforce stroke:#c00,stroke-width:2px;');
  const stages = wf.nodes.filter((n) => n.kind === 'stage');
  const gates = wf.nodes.filter((n) => n.kind === 'gate');
  const rl = ripeLabel(wf.ripeRequires);

  for (const s of stages) L.push(`  s_${sanitize(s.id)}("${esc(s.label)}")`);
  for (const s of stages) {
    for (const p of s.preds) {
      const label = s.id === wf.ripeStageId && rl ? `|${esc(rl)}|` : '';
      L.push(`  s_${sanitize(p)} -->${label} s_${sanitize(s.id)}`);
    }
  }
  for (const g of gates) {
    const gid = `g_${sanitize(g.id)}`;
    const meta = `${g.gate.authority} · ${g.gate.artifact} · ${g.gate.mode}`;
    L.push(`  ${gid}{{"${esc(g.label)}<br/>when ${esc(g.gate.situation)}<br/>${esc(meta)}"}}`);
    if (wf.ripeStageId) L.push(`  ${gid} -.gate.-> s_${sanitize(wf.ripeStageId)}`);
    L.push(`  class ${gid} gate${g.gate.mode === 'enforce' ? ',enforce' : ''}`);
  }
  L.push('```');
  return L.join('\n');
}

export function renderSection(workflows) {
  const L = [];
  for (const wf of workflows) {
    L.push(`### ${wf.goalType}`, '', renderWorkflow(wf), '');
  }
  while (L.length && L[L.length - 1] === '') L.pop();
  return L.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/diagram.test.mjs`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/diagram.mjs test/diagram.test.mjs
git commit -m "feat(diagram): mermaid renderer for stages + gate guards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Marker-fenced README section read/write (`replaceSection`, `isInSync`)

**Files:**
- Modify: `src/diagram.mjs`
- Test: `test/diagram.test.mjs`

**Interfaces:**
- Consumes: a `body` string from `renderSection` (Task 2).
- Produces:
  - `START`, `END` marker constants.
  - `replaceSection(readme, body) -> string` (throws if markers absent/malformed).
  - `currentSection(readme) -> string|null` (content between markers, or null).
  - `isInSync(readme, body) -> boolean`.

- [ ] **Step 1: Write the failing test**

Append to `test/diagram.test.mjs`:

```js
import { replaceSection, currentSection, isInSync, START, END } from '../src/diagram.mjs';

const README = `# Title\n\nintro\n\n## Workflows\n\npreamble\n\n${START}\nOLD\n${END}\n\n## Next\n`;

test('replaceSection: replaces only between markers, preserves surrounding prose', () => {
  const out = replaceSection(README, 'NEW BODY');
  assert.ok(out.includes(`${START}\nNEW BODY\n${END}`));
  assert.ok(out.startsWith('# Title\n'));
  assert.ok(out.includes('## Next'));
  assert.ok(!out.includes('OLD'));
});

test('replaceSection then isInSync is clean; second replace is a no-op', () => {
  const once = replaceSection(README, 'BODY');
  assert.ok(isInSync(once, 'BODY'));
  assert.equal(replaceSection(once, 'BODY'), once);
});

test('isInSync: false when the section body differs', () => {
  assert.equal(isInSync(README, 'BODY'), false);
});

test('currentSection: returns null when markers are absent', () => {
  assert.equal(currentSection('# no markers here'), null);
});

test('replaceSection: throws with guidance when markers are missing', () => {
  assert.throws(() => replaceSection('# no markers', 'BODY'), /markers not found/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/diagram.test.mjs`
Expected: FAIL — `replaceSection is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/diagram.mjs`:

```js
// --- README section (marker-fenced, idempotent) -----------------------------

export const START = '<!-- tiller:workflows:start -->';
export const END = '<!-- tiller:workflows:end -->';

function region(readme) {
  const si = readme.indexOf(START);
  const ei = readme.indexOf(END);
  if (si === -1 || ei === -1 || ei < si) return null;
  return { si, ei };
}

export function currentSection(readme) {
  const r = region(readme);
  return r ? readme.slice(r.si + START.length, r.ei) : null;
}

export function isInSync(readme, body) {
  return currentSection(readme) === `\n${body}\n`;
}

export function replaceSection(readme, body) {
  const r = region(readme);
  if (!r) {
    throw new Error(
      `README markers not found. Add a "## Workflows" section containing exactly:\n` +
      `${START}\n${END}\nthen re-run --write.`,
    );
  }
  const before = readme.slice(0, r.si + START.length);
  const after = readme.slice(r.ei);
  return `${before}\n${body}\n${after}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/diagram.test.mjs`
Expected: PASS (15 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/diagram.mjs test/diagram.test.mjs
git commit -m "feat(diagram): idempotent marker-fenced README section writer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: CLI `main()` wired to resolved config

**Files:**
- Modify: `src/diagram.mjs`
- Test: `test/diagram.test.mjs`

**Interfaces:**
- Consumes: all pure functions above; dynamically imports `DELIVERY_TEMPLATE`, `GATES` from `./config.mjs` and `GOAL_TYPES` from `./templates.mjs`.
- Produces: `main(argv) -> Promise<number>` (exit code); direct-invocation guard.

- [ ] **Step 1: Write the failing test**

Append to `test/diagram.test.mjs` (an integration test that spawns the CLI against the real self-hosted config):

```js
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('CLI: default mode prints a mermaid section wrapped in markers', () => {
  const out = execFileSync('node', ['src/diagram.mjs'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, TILLER_CONFIG: './tiller.config.mjs' },
  });
  assert.ok(out.includes(START));
  assert.ok(out.includes(END));
  assert.ok(out.includes('### delivery'));
  assert.ok(out.includes('graph LR'));
});
```

(The `--check`-exits-0 integration test is deliberately added in Task 5, *after*
the README section exists — adding it here would commit a red test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/diagram.test.mjs`
Expected: FAIL — default mode prints nothing / non-zero exit (`main` not implemented). The `--check` test will also fail until Task 5; that is expected and turns green there.

- [ ] **Step 3: Write minimal implementation**

Add to `src/diagram.mjs` (imports at top of file, alongside the header — these are the only node-builtin imports):

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
```

Then at the end of the file:

```js
// --- CLI --------------------------------------------------------------------

export async function main(argv) {
  const { DELIVERY_TEMPLATE, GATES } = await import('./config.mjs');
  const { GOAL_TYPES } = await import('./templates.mjs');
  const workflows = buildWorkflows({
    goalTypes: GOAL_TYPES, deliveryTemplate: DELIVERY_TEMPLATE, gates: GATES,
  });
  const body = renderSection(workflows);

  const mode = argv[0];
  if (mode === '--write' || mode === '--check') {
    const path = resolve(argv[1] ?? 'README.md');
    const readme = readFileSync(path, 'utf8');
    if (mode === '--check') {
      if (isInSync(readme, body)) { console.log('workflow diagrams in sync'); return 0; }
      console.error('README workflow diagrams are STALE — run: node src/diagram.mjs --write README.md');
      return 1;
    }
    const next = replaceSection(readme, body);
    if (next === readme) { console.log(`${path} already in sync`); return 0; }
    writeFileSync(path, next);
    console.log(`updated ${path}`);
    return 0;
  }
  console.log(`${START}\n${body}\n${END}`);
  return 0;
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/diagram.test.mjs`
Expected: all tests PASS — the 15 pure tests plus `CLI: default mode prints a mermaid section wrapped in markers` (16 total).

- [ ] **Step 5: Commit**

```bash
git add src/diagram.mjs test/diagram.test.mjs
git commit -m "feat(diagram): TILLER_CONFIG-aware CLI (stdout / --write / --check)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add the README `## Workflows` section and populate it

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the `--write` CLI (Task 4). No new code.

- [ ] **Step 1: Add the section with a static preamble and empty markers**

Insert a new `## Workflows` section into `README.md` immediately before `## Situational gates (shadow-first)` (keeps workflow shape next to gate detail). Use this exact block:

```markdown
## Workflows

Each goal type is a **workflow**: an ordered set of stages plus the situational
gates that guard progression to `ripe`. Diagrams below are generated from the
active config (`tiller.config.mjs`) by `node src/diagram.mjs` — do not edit
between the markers by hand; CI (`--check`) fails if they drift.

<!-- tiller:workflows:start -->
<!-- tiller:workflows:end -->

```

- [ ] **Step 2: Populate the section from config**

Run:
```bash
TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --write README.md
```
Expected stdout: `updated <abs>/README.md`

- [ ] **Step 3: Verify sync and eyeball the mermaid**

Run:
```bash
TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md
```
Expected: prints `workflow diagrams in sync`, exit 0.

Then open `README.md` and confirm the `### delivery` block shows the
`shaped → ripe → pr-open → merged` chain with `classifier-fuzz` and
`classifier-spec-sync` hexagons dashed into `ripe`, and a `### journey` block
shows `elaborated → children-done → closed`. (Optional visual check: paste the
mermaid block into https://mermaid.live to confirm it parses.)

- [ ] **Step 4: Add the `--check`-exits-0 integration test (now that the README section exists)**

Append to `test/diagram.test.mjs`:

```js
test('CLI: --check on this repo README exits 0 (kept in sync)', () => {
  let code = 0;
  try {
    execFileSync('node', ['src/diagram.mjs', '--check', 'README.md'], {
      cwd: ROOT, env: { ...process.env, TILLER_CONFIG: './tiller.config.mjs' }, stdio: 'pipe',
    });
  } catch (e) { code = e.status; }
  assert.equal(code, 0);
});
```

Then run the full suite:
```bash
node --test 'test/*.test.mjs'
```
Expected: all tests PASS, including the new `CLI: --check on this repo README exits 0` (17 diagram tests total) and the pre-existing engine suite.

- [ ] **Step 5: Commit**

```bash
git add README.md test/diagram.test.mjs
git commit -m "docs(readme): generated Workflows section (delivery + journey DAGs)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: CI drift-gate

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `--check` CLI (Task 4). No new code.

- [ ] **Step 1: Add a `diagram` job**

Append this job to `.github/workflows/ci.yml` (sibling of `test`/`fuzz`/`spec`; keep the two-space job indentation):

```yaml
  diagram:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6.0.2
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: README workflow diagrams in sync
        run: TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md
```

Also add `#   diagram — the README Workflows mermaid section matches the active config` to the header comment block listing the gates.

- [ ] **Step 2: Verify the job command locally**

Run:
```bash
TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md; echo "exit=$?"
```
Expected: `workflow diagrams in sync` then `exit=0`.

- [ ] **Step 3: Confirm the drift path fails (sanity, then revert)**

Run:
```bash
cp README.md /tmp/README.bak
node -e "const f='README.md';const fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('graph LR','graph TD'))"
TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md; echo "exit=$?"
cp /tmp/README.bak README.md
```
Expected: prints the STALE message then `exit=1`; after the restore, README is unchanged (`git status` clean for README.md).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(diagram): gate README Workflows section against config drift

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The `render-workflows` skill

**Files:**
- Create: `.claude/skills/render-workflows/SKILL.md`

**Interfaces:**
- Consumes: the CLI (Task 4). No new code.

- [ ] **Step 1: Write the skill**

Create `.claude/skills/render-workflows/SKILL.md` (tiller has no `.claude/` yet — this creates it):

```markdown
---
name: render-workflows
description: Regenerate the README "Workflows" mermaid diagrams from the active tiller config. Use after changing any goal type's stages, the DELIVERY_TEMPLATE, or the GATES in engine.config.mjs / tiller.config.mjs — or when a workflow diagram looks stale. Triggers — "render the workflows", "update the workflow diagrams", "regenerate the README DAGs".
---

# render-workflows

`src/diagram.mjs` renders each goal type's workflow — its stages plus the
situational gates guarding `ripe` — as mermaid, and maintains the marked
`## Workflows` section of `README.md`. It reads the **resolved** config exports
(`DELIVERY_TEMPLATE`, `GATES`, `GOAL_TYPES`), so the diagram never disagrees
with what the classifier runs.

## When to run

After any change to workflow topology: a goal type's `stages`, the
`DELIVERY_TEMPLATE` override, or a `GATES` entry (`appliesWhen`, `authority`,
`mode`, `requires.artifact`). CI's `diagram` job runs `--check` and fails the
build if you forget — this skill is how you fix that failure.

## Commands (from the repo root)

Regenerate the README section in place:

    TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --write README.md

Check for drift without writing (what CI runs):

    TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md

Print the section to stdout (e.g. to preview a consumer config):

    TILLER_CONFIG=./path/to/consumer.config.mjs node src/diagram.mjs

## Notes

- Never hand-edit between `<!-- tiller:workflows:start -->` and
  `<!-- tiller:workflows:end -->`; `--write` owns that region.
- The README renders **`tiller.config.mjs`** (the self-hosted thin template
  that governs this repo), not the `engine.config.mjs` fallback.
- Do not edit the mermaid by hand — change the config, then re-run `--write`.
```

- [ ] **Step 2: Verify the skill's commands actually work**

Run both commands from the skill and confirm they behave as documented:
```bash
TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md; echo "exit=$?"
TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --write README.md
git status --porcelain README.md
```
Expected: `--check` prints in-sync, `exit=0`; `--write` prints `already in sync`; `git status` shows README.md unchanged.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/render-workflows/SKILL.md
git commit -m "docs(skill): render-workflows — regenerate README DAGs from config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full suite green:** `node --test 'test/*.test.mjs'` — all pass.
- [ ] **Drift gate green:** `TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md` prints in-sync, exit 0.
- [ ] **No stray deps:** `git diff main -- package.json` (if present) is empty; grep confirms `src/diagram.mjs` imports only `node:` builtins statically.
- [ ] **README renders:** the `## Workflows` section shows a `### delivery` and `### journey` mermaid block; optionally confirmed in mermaid.live.

## Landing

Per repo convention (direct-to-main, FF-push): fast-forward `main` to this
worktree branch and FF-push. No strengthsys submodule pin bump is required for
this devx change; the operator bumps the pin separately if desired.
