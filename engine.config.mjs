// engine.config.mjs — per-repo gate + sensor configuration.
//
// This is the TILLER_CONFIG-less fallback: the historical in-tree defaults
// the engine grew up with in strengthsys (documented in the README). The
// SELF-HOSTED instance — the engine sensing this repo's own issues — is
// `tiller.config.mjs` at the repo root; see README "Self-hosting".
//
// GATES are SITUATIONAL: `appliesWhen` is a data predicate over what the
// engine knows about a goal (type, labels, body-cited paths) — a gate binds
// only in the situations that make its prework necessary, never universally
// (the agent-team-overweight lesson). Gates start in `mode: 'shadow'`: the
// tick reports what WOULD park, nothing is blocked. A gate graduates to
// `mode: 'enforce'` individually, on its divergence record (event-count, not
// wall-clock).
//
// `authority` says who DECIDES the verdict (an agent always applies the
// fact): 'sensor' = mechanically decided by a command; 'operator' = an agent
// may challenge/refine, but the verdict fact must carry source:'operator'
// (recorded via `node src/attest.mjs`).

export const GATES = [
  {
    // The easy end: cited Allium specs must be clean before implementation.
    id: 'spec-check-clean',
    description: 'cited Allium specs pass `allium check` + `analyse` with 0 errors/warnings',
    mode: 'shadow',
    authority: 'sensor',
    appliesWhen: { goalType: 'delivery', bodyCites: 'spec/[A-Za-z0-9_-]+\\.allium' },
    requires: { artifact: 'spec-check' },
  },
  {
    // The hard end: journey/value articulation is an operator judgement.
    // The agent's job is the challenge conversation; the stamp is not its to give.
    id: 'journey-articulation',
    description: 'user journey + value articulation attested by the operator',
    mode: 'shadow',
    authority: 'operator',
    appliesWhen: { goalType: 'journey' },
    requires: { artifact: 'journey-articulation', source: 'operator' },
  },
];

export const SENSORS = {
  // artifact -> how to mechanically produce its validity verdict.
  'spec-check': {
    kind: 'allium',
    commands: [['allium', 'check'], ['allium', 'analyse']],
    failOn: ['error', 'warning'], // info diagnostics are allowed
  },
};
