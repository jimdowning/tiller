import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, descopeContradictions } from '../src/sense/translate.mjs';
import { fold } from '../src/classify.mjs';

const NOW = '2026-07-05T12:00:00Z';

const issue = (over = {}) => ({
  number: 1, isPR: false, title: 'A goal', body: '', state: 'open',
  createdAt: '2026-07-01T00:00:00Z', closedAt: null,
  labels: [], events: [], comments: [], ...over,
});

const run = (items, externals = new Map()) => {
  const { facts, meta } = translate(items, externals, NOW);
  return { out: fold(facts), facts, meta };
};

test('unconditioned delivery goal parks as needs-conditioning', () => {
  const { out } = run([issue()]);
  assert.equal(out.get(1).bucket, 'parked');
  assert.equal(out.get(1).reason, 'needs-conditioning');
});

test('full conditioning contract makes the goal ripe', () => {
  const { out } = run([issue({
    labels: ['conditioned', 'blast-radius:module-local', 'reversibility:easy'],
  })]);
  assert.equal(out.get(1).bucket, 'ripe');
});

test('conditioned label alone (E0-04 mechanical fault) stays parked', () => {
  const { out } = run([issue({ labels: ['conditioned'] })]);
  assert.equal(out.get(1).bucket, 'parked');
});

test('conditioning granted via label events unparks at the event', () => {
  const { out } = run([issue({
    labels: ['conditioned', 'blast-radius:isolated', 'reversibility:easy'],
    events: [
      { ts: '2026-07-02T00:00:00Z', event: 'labeled', label: 'conditioned' },
      { ts: '2026-07-02T00:00:00Z', event: 'labeled', label: 'blast-radius:isolated' },
      { ts: '2026-07-02T00:00:00Z', event: 'labeled', label: 'reversibility:easy' },
    ],
  })]);
  assert.equal(out.get(1).bucket, 'ripe');
});

test('operator label parks; removing it (operator acting) unparks', () => {
  const conditioned = ['conditioned', 'blast-radius:isolated', 'reversibility:easy'];
  const parked = run([issue({ labels: [...conditioned, 'needs-operator'] })]);
  assert.equal(parked.out.get(1).bucket, 'parked');
  assert.equal(parked.out.get(1).reason, 'operator');

  const released = run([issue({
    labels: conditioned,
    events: [
      { ts: '2026-07-02T00:00:00Z', event: 'labeled', label: 'needs-operator' },
      { ts: '2026-07-03T00:00:00Z', event: 'unlabeled', label: 'needs-operator' },
    ],
  })]);
  assert.equal(released.out.get(1).bucket, 'ripe');
});

test('po-todo label (the milestone replacement) is an operator park', () => {
  const { out } = run([issue({ labels: ['po-todo'] })]);
  assert.equal(out.get(1).bucket, 'parked');
  // multi-park: unconditioned AND operator-parked, both blockers visible
  assert.deepEqual(out.get(1).parks.map((p) => p.reason).sort(),
    ['needs-conditioning', 'operator']);
});

test('ACTION REQUIRED comment parks; a later **FYI** resolver unparks', () => {
  const base = issue({ labels: ['conditioned', 'blast-radius:isolated', 'reversibility:easy'] });
  const parked = run([{ ...base,
    comments: [{ ts: '2026-07-02T00:00:00Z', author: 'bot', body: '**ACTION REQUIRED** decide X' }] }]);
  assert.equal(parked.out.get(1).bucket, 'parked');

  const resolved = run([{ ...base,
    comments: [
      { ts: '2026-07-02T00:00:00Z', author: 'bot', body: '**ACTION REQUIRED** decide X' },
      { ts: '2026-07-03T00:00:00Z', author: 'op', body: '**FYI** decided: option A' },
    ] }]);
  assert.equal(resolved.out.get(1).bucket, 'ripe');
});

test('dep-block comment with ref creates a real waiting edge; closed dep releases it', () => {
  const base = issue({
    labels: ['conditioned', 'blast-radius:isolated', 'reversibility:easy'],
    comments: [{ ts: '2026-07-02T00:00:00Z', author: 'bot',
      body: 'startable: no — blocked by sibling #7' }],
  });
  const waiting = run([base], new Map([[7, { state: 'open', title: 'dep' }]]));
  assert.equal(waiting.out.get(1).bucket, 'waiting');
  assert.deepEqual(waiting.out.get(1).dependencies, [7]);

  const released = run([base], new Map([[7, { state: 'closed', title: 'dep', closedAt: '2026-07-04T00:00:00Z' }]]));
  assert.equal(released.out.get(1).bucket, 'ripe');
});

test('dep-block comment with NO ref parks as untracked-dependency (E6 #419)', () => {
  const { out } = run([issue({
    labels: ['conditioned', 'blast-radius:isolated', 'reversibility:easy'],
    comments: [{ ts: '2026-07-02T00:00:00Z', author: 'bot',
      body: 'startable: no — blocked — needs a sibling that is not yet filed' }],
  })]);
  assert.equal(out.get(1).bucket, 'parked');
  assert.equal(out.get(1).reason, 'untracked-dependency');
});

test('startable: yes retires previously sensed comment deps', () => {
  const { out } = run([issue({
    labels: ['conditioned', 'blast-radius:isolated', 'reversibility:easy'],
    comments: [
      { ts: '2026-07-02T00:00:00Z', author: 'bot', body: 'startable: no — blocked by sibling #7' },
      { ts: '2026-07-03T00:00:00Z', author: 'bot', body: 're-derisked. startable: yes' },
    ],
  })], new Map([[7, { state: 'open', title: 'dep' }]]));
  assert.equal(out.get(1).bucket, 'ripe');
});

test('journey: task-list children become dependency edges; journey ripens when all close', () => {
  const journey = issue({
    number: 10, title: 'Journey: athlete onboarding',
    labels: ['goal:journey', 'focus:current'],
    body: 'Value: athlete can onboard.\n\n- [x] #11\n- [ ] #12\n',
  });
  const child11 = issue({ number: 11, state: 'closed', closedAt: '2026-07-03T00:00:00Z',
    events: [{ ts: '2026-07-03T00:00:00Z', event: 'closed' }] });
  const child12 = issue({ number: 12 });

  const { out, meta } = run([journey, child11, child12]);
  assert.equal(out.get(10).bucket, 'waiting');
  assert.deepEqual(out.get(10).dependencies, [12]);
  assert.equal(meta.get(10).focus, 'current');

  const done12 = { ...child12, state: 'closed', closedAt: '2026-07-04T00:00:00Z',
    events: [{ ts: '2026-07-04T00:00:00Z', event: 'closed' }] };
  const after = run([journey, child11, done12]);
  assert.equal(after.out.get(10).bucket, 'ripe'); // ready for the closing decision
});

test('Part of #N in a child body declares the parent→child edge', () => {
  const parent = issue({ number: 10, title: 'Journey: X', labels: ['goal:journey'] });
  const child = issue({ number: 3, body: 'Does a thing.\n\nPart of #10.' });
  const { out } = run([parent, child]);
  assert.equal(out.get(10).bucket, 'waiting');
  assert.deepEqual(out.get(10).dependencies, [3]);
});

test('meta trackers are excluded; journeys are not', () => {
  const { out } = run([
    issue({ number: 1, title: 'Elaboration: milestone 9' }),
    issue({ number: 2, title: 'Journey: onboarding', labels: ['goal:journey'] }),
  ]);
  assert.equal(out.has(1), false);
  assert.equal(out.get(2).bucket, 'ripe');
});

test('merged PR produces a pr-merged artifact on the issue it closes', () => {
  const { out } = run([
    issue({ number: 5, labels: ['conditioned', 'blast-radius:isolated', 'reversibility:easy'] }),
    issue({ number: 6, isPR: true, title: 'feat: thing', body: 'Closes #5',
      events: [{ ts: '2026-07-03T00:00:00Z', event: 'merged', commit: 'abc' }] }),
  ]);
  assert.ok(out.get(5).artifacts.includes('pr#6'));
  assert.ok(out.get(5).artifacts.includes('pr#6-merged'));
});

test('descope: a deleted task-list line contradicts the body-sourced edge', () => {
  const journeyV1 = issue({ number: 10, labels: ['goal:journey'], body: '- [ ] #11\n- [ ] #12\n' });
  const kids = [issue({ number: 11 }), issue({ number: 12 })];
  const t1 = translate([journeyV1, ...kids], new Map(), NOW);
  let storeFacts = [...t1.facts];
  assert.deepEqual(fold(storeFacts).get(10).dependencies.sort(), [11, 12]);

  const journeyV2 = { ...journeyV1, body: '- [ ] #11\n' }; // #12 descoped
  const t2 = translate([journeyV2, ...kids], new Map(), '2026-07-06T00:00:00Z');
  storeFacts = [...storeFacts, ...t2.facts,
    ...descopeContradictions([...storeFacts, ...t2.facts], t2.meta, '2026-07-06T00:00:00Z')];
  const out = fold(storeFacts);
  assert.deepEqual(out.get(10).dependencies, [11]);
});

test('re-translation is idempotent under the fold (same classification)', () => {
  const items = [issue({
    labels: ['conditioned', 'blast-radius:isolated', 'reversibility:easy'],
    comments: [{ ts: '2026-07-02T00:00:00Z', author: 'bot', body: 'startable: no — blocked by sibling #7' }],
  })];
  const ext = new Map([[7, { state: 'open', title: 'dep' }]]);
  const t1 = translate(items, ext, NOW);
  const t2 = translate(items, ext, NOW);
  const once = fold(t1.facts);
  const twice = fold([...t1.facts, ...t2.facts]);
  assert.deepEqual([...twice.entries()], [...once.entries()]);
});
