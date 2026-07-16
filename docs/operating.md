# Operating tiller

Everything you need to run tiller — against its own repo, or against another one
as a submodule. For the mental model behind these commands, see
[Concepts](concepts.md); for the internals, see [Architecture](architecture.md).

- [Commands](#commands)
- [Configuration: `TILLER_CONFIG`](#configuration)
- [Running against a target repo](#target-repo)
- [Self-hosting (tiller-on-tiller)](#self-hosting)
- [The consumer pin-bump gate](#pin-bump)
- [CI gates](#ci)

<a id="commands"></a>
## Commands

Run from the repo root. By default the engine reads `engine.config.mjs` and
senses its own backlog; to sense another repo, prefix with `TILLER_CONFIG=...`
(see [below](#configuration)).

| command | what it does |
|---|---|
| `node src/tick.mjs` | one live reconciliation tick: fetch (read-only), append facts, classify, verify/gate, and write a dated snapshot |
| `node src/tick.mjs --offline` | re-derive the plan from the **stored** fact log only — no network. Same log ⇒ same plan |
| `node src/tick.mjs --no-hysteresis` | report **raw** ripeness, skipping the hysteresis damping |
| `node src/tick.mjs --accept-shrink` | accept an implausibly shrunken open set (a genuine mass-close) — see [degraded senses](architecture.md#degraded-senses) |
| `node src/tick.mjs --full` | drill every item, ignoring the `updated_at` watermarks (#6) — run periodically (the scheduled workflow does, weekly) to catch cross-reference-only changes that don't bump an item's `updated_at` |
| `node src/explain.mjs <n>` | why isn't `#n` ripe, and exactly what would clear each of its parks |
| `node src/next.mjs` | capability-matched selection: what can **this** session pick up right now, given the tools it has? (`--as operator`, `--capabilities gh,pnpm`, `--all` to show skipped-and-why) |
| `node src/attest.mjs <n> <gate> pass` | record a verdict stamp for a gate. **`--post`** posts it as a `tiller:attest` issue comment the next tick senses — durable across machines/CI (#23); without it the fact is appended to the machine-local log only. `--source operator\|agent\|sensor` (default `operator`) declares the claimed authority — capped at sense time by the comment author's ceiling, so agents must say `--source agent` |
| `node src/heartbeat.mjs <source>` | append a liveness pulse from a `/loop`-wrapped stream (`source` = a goal number, which fires that goal's `budget-exhausted` unpark, or a stream name) |
| `node src/migrate.mjs` | read-only milestones → journeys migration plan |
| `node src/diagram.mjs` | render the workflow diagrams from the active config (`--write README.md` to update, `--check README.md` to fail on drift) |

Development checks:

```bash
node --test 'test/*.test.mjs'   # the test suite
node test/fuzz.mjs              # classifier property fuzzer (the CI correctness gate)
node scripts/check-spec.mjs     # allium check/analyse on every spec in spec/ (warnings ratcheted)
```

<a id="configuration"></a>
## Configuration: `TILLER_CONFIG`

By default the engine reads `engine.config.mjs` next to `src/` and keeps its state
and snapshots **inside the engine directory** — the historical in-tree behaviour,
so the commands above work from a bare checkout with no setup.

To run against a target repo, set `TILLER_CONFIG` to a config `.mjs` in that repo:

```bash
TILLER_CONFIG=./tiller.config.mjs node tiller/src/tick.mjs
```

**Relative-path resolution.** A relative `TILLER_CONFIG` resolves against the
_invoking_ working directory, trying (in order) `INIT_CWD` (set by npm/pnpm
scripts), `PWD` (the shell's cwd), then the process cwd — **never** silently
against the engine directory. So a caller that spawns the engine with its cwd set
to the engine dir still gets the config it named. If the file is found under none
of those bases, config loading **fails loudly** and lists what it tried; pass an
absolute path to be fully explicit.

**What a config exports.** Everything `engine.config.mjs` exports (`GATES`,
`SENSORS`) plus optional path settings, each resolved **relative to the config
file's own directory** (so a config at a target repo's root is robust to the
caller's cwd):

| export | meaning |
|---|---|
| `stateDir` | fact log, hysteresis memory, meta cache — machine-local; **gitignore it** |
| `snapshotDir` | derived-plan snapshots `<date>.{json,md}` — date-named, so conflict-free; **commit them** |
| `repoRoot` | the sensed repo's root, used by mechanical sensors such as spec-check (default: the config file's directory) |
| `OPERATORS` | GitHub logins whose `tiller:attest` comments may claim **operator** authority (#23). Default `[]`: no comment can carry an operator-source verdict until the repo declares its operators. `*[bot]` authors cap at `sensor`, everyone else at `agent`; over-claims are downgraded to the author's ceiling, never trusted |
| `DELIVERY_TEMPLATE` | optional per-repo override of the delivery goal's stages + ripeness contract (replaces the engine default in `src/templates.mjs`; consumers that don't override keep the heavyweight default) |

<a id="target-repo"></a>
## Running against a target repo

The typical integration is as a **git submodule**: the consumer repo pins a
specific tiller commit and keeps its own `tiller.config.mjs` at the root, pointing
`stateDir` at `.tiller/state/` (gitignored) and `snapshotDir` at
`.tiller/snapshots/` (committed):

```bash
git submodule update --init tiller
TILLER_CONFIG=./tiller.config.mjs node tiller/src/tick.mjs
```

Because the consumer pins tiller by SHA, **nothing in tiller affects the consumer
until a deliberate pin bump** — which has its own gate (below).

<a id="self-hosting"></a>
## Self-hosting (tiller-on-tiller)

This repo dogfoods its own engine (goal #1): the root `tiller.config.mjs` is a
consumer-shaped config that senses `jimdowning/tiller` itself.

```bash
TILLER_CONFIG=./tiller.config.mjs node src/tick.mjs
```

State lands in `.tiller/state/` (gitignored), snapshots in `.tiller/snapshots/`
(committed). Development here runs a deliberately **thin delivery template** — the
per-repo override exists for exactly this:

- Stages are `shaped → ripe → pr-open → merged`; the whole ripeness contract is a
  single `shaped` label. No blast-radius taxonomy, no reversibility label, no
  ceremony floor — the heavyweight default a larger consumer would use is left
  untouched for anyone who doesn't override it.
- Changes land as commits straight to `main` (no PRs unless contested);
  **fast-forward pushes only**, so the SHAs a consumer has pinned stay reachable.
- Two day-one situational gates run in **shadow** on goals that touch the
  classifier/fold: `classifier-fuzz` (a passing `fuzz-run` verdict from the command
  sensor, input-hash keyed on `src/classify.mjs` + `src/schema.mjs` + the fuzzer)
  and `classifier-spec-sync` (the `spec/goal-liveness.allium` update, attested by
  the **operator** — an agent-sourced pass does not satisfy it).
- The plan stays current **on a schedule** (#24): `.github/workflows/tick.yml`
  runs a daily watermarked tick (weekly `--full`) and commits the snapshot.
  `.tiller/state/` continuity is a best-effort Actions cache — a cold cache is
  safe by design (sensing is stateless and idempotent), and attestations reach
  the runner as sensed comments (#23), never as local state.

<a id="pin-bump"></a>
## The consumer pin-bump gate

A consumer is insulated by its submodule pin, so bumping that pin is the one moment
tiller can change a consumer's coordination. A pin-bump PR **must include an
offline snapshot diff**: run `tick.mjs --offline` over the consumer's stored fact
log under both the old and the new engine, and diff the resulting buckets.

```bash
# in the consumer repo, once per engine version.
# copy the state so the real hysteresis/snapshots are untouched:
cp -r .tiller/state /tmp/pin-diff-state
TILLER_CONFIG=/tmp/pin-diff.config.mjs node <old-engine>/src/tick.mjs --offline
TILLER_CONFIG=/tmp/pin-diff.config.mjs node <new-engine>/src/tick.mjs --offline
# diff the two snapshot .json files: bucket counts + per-goal membership
```

The point: bucket changes computed on **real historical facts** are exactly what
the bump review reads. An intended semantic change shows up as an explainable
membership diff; an unintended one is a regression caught **before** the pin lands.

<a id="ci"></a>
## CI gates

`.github/workflows/ci.yml` runs four gates on every push and PR:

| gate | command | what it protects |
|---|---|---|
| **test** | `node --test 'test/*.test.mjs'` | the unit/integration suite |
| **fuzz** | `node test/fuzz.mjs 12000` | classifier totality — every fact-log yields exactly one bucket |
| **spec** | `node scripts/check-spec.mjs` | every behavioral contract spec in `spec/` (errors fail; warnings ratcheted per spec) |
| **diagram** | `TILLER_CONFIG=./tiller.config.mjs node src/diagram.mjs --check README.md` | the README Workflows section matches the active config |

The **diagram** gate is why the Workflows section in `README.md` is
marker-fenced and must not be hand-edited: after any change to the goal templates
or gates, regenerate it with `node src/diagram.mjs --write README.md` and commit
the result.

Alongside the gates, `.github/workflows/tick.yml` runs the [scheduled
self-tick](#self-hosting) — not a gate, but the cadence that keeps the
self-hosted derived plan current.
