// sense/github.mjs — read-only GitHub sensor. Structurally read-only: every
// call is `gh api -X GET` (or --paginate GETs). No mutating verbs anywhere.
//
// ISSUES-ONLY: fetches issues, their timelines, comments, and BODIES (bodies
// are load-bearing now — task-list membership, Part-of links, and the thin
// verifier all read them). Milestone events are ignored entirely.
//
// Adapted from e6-live-shadow/src/fetch-current.mjs, with bodies retained and
// external dependency refs resolved the same way (a closed dep must read as
// closed, not absent).
import { execFileSync } from 'node:child_process';

function gh(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

export function detectRepo() {
  const info = gh(['repo', 'view', '--json', 'nameWithOwner']);
  return info.nameWithOwner;
}

/** A sense that must not be trusted as the full open set (#4). */
export class DegradedSenseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DegradedSenseError';
  }
}

/**
 * Collect every page of a GitHub search, refusing degraded results (#4).
 *
 * `fetchPage(page)` returns the raw search payload
 * `{ total_count, incomplete_results, items }`. GitHub signals a degraded
 * (timed-out, partial) search with `incomplete_results: true` and NO error —
 * treating that as the open set would silently shrink downstream state, so
 * it throws instead. A collected count short of `total_count` (e.g. the
 * pagination safety bound truncating) throws for the same reason.
 */
export function collectSearchPages(fetchPage, { maxPages = 12 } = {}) {
  const all = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    const res = fetchPage(page) ?? {};
    if (res.incomplete_results) {
      throw new DegradedSenseError(
        `GitHub search returned incomplete_results=true on page ${page} ` +
        `(${all.length + (res.items?.length ?? 0)} items so far) — ` +
        'refusing to treat a partial result set as the open set');
    }
    if (typeof res.total_count === 'number') total = res.total_count;
    const items = res.items ?? [];
    all.push(...items);
    if (items.length < 100) break;
  }
  if (total != null && all.length < total) {
    throw new DegradedSenseError(
      `GitHub search yielded ${all.length} of ${total} matching items — ` +
      'refusing to treat a truncated result set as the open set');
  }
  return all;
}

function listOpenItems(repo) {
  return collectSearchPages((page) => gh([
    'api', '-X', 'GET', 'search/issues',
    '-f', `q=repo:${repo} is:open`,
    '-f', 'per_page=100', '-f', `page=${page}`,
  ]));
}

/**
 * Fetch the live open set. The LIST is always fetched in full (cheap — ~1 API
 * page per 100 items — and the shrink guard #4 needs the complete list); the
 * per-item DRILL (timeline + comments, the network-bound part) is gated by
 * `shouldDrill` (#6): the caller passes a watermark predicate over
 * `{ number, isPR, updatedAt }`, and items it declines come back shallow in
 * `skipped`. Facts for a skipped item are already in the caller's append-only
 * log — an unchanged `updated_at` means re-drilling would re-derive facts
 * that all dedup to no-ops, so skipping just skips paying for the no-op.
 *
 * Returns { drilled, skipped }:
 *   drilled — full items { number, isPR, updatedAt, title, body, state,
 *             createdAt, closedAt, labels, events: [{ts, event, ...}],
 *             comments: [{ts, author, body}] }
 *   skipped — shallow { number, isPR, updatedAt }
 */
export function fetchOpenSet(repo, { shouldDrill = () => true } = {}) {
  const items = listOpenItems(repo);
  const drilled = [];
  const skipped = [];
  for (const it of items) {
    const num = it.number;
    const head = { number: num, isPR: !!it.pull_request, updatedAt: it.updated_at ?? null };
    if (!shouldDrill(head)) {
      skipped.push(head);
      continue;
    }
    let timeline = [];
    try {
      timeline = gh(['api', `repos/${repo}/issues/${num}/timeline`, '--paginate']);
    } catch (e) {
      console.error(`  timeline fail #${num}: ${e.message.split('\n')[0]}`);
    }
    let comments = [];
    try {
      comments = gh(['api', `repos/${repo}/issues/${num}/comments`, '--paginate']);
    } catch (e) {
      console.error(`  comments fail #${num}: ${e.message.split('\n')[0]}`);
    }
    drilled.push({
      ...head,
      title: it.title || '',
      body: it.body || '',
      state: it.state,
      createdAt: it.created_at,
      closedAt: it.closed_at,
      labels: (it.labels || []).map((l) => l.name),
      events: timeline
        .filter((ev) => ev.created_at)
        .map((ev) => ({
          ts: ev.created_at, event: ev.event,
          label: ev.label?.name, actor: ev.actor?.login, commit: ev.commit_id,
        })),
      comments: comments.map((c) => ({
        ts: c.created_at, author: c.user?.login, body: c.body || '',
      })),
    });
  }
  return { drilled, skipped };
}

/**
 * Resolve refs pointing outside the open set (closed deps must read as done).
 * Returns Map<number, {state, title}> for every referenced number not in
 * `known`.
 */
export function resolveExternalRefs(repo, referenced, known) {
  const resolved = new Map();
  for (const n of referenced) {
    if (known.has(n)) continue;
    try {
      const info = gh(['api', `repos/${repo}/issues/${n}`]);
      resolved.set(n, {
        state: info.state, title: info.title || '',
        closedAt: info.closed_at, createdAt: info.created_at,
      });
    } catch {
      // unknown/deleted ref — leave absent; the classifier treats an absent
      // dep as still-blocking, the safe re-checkable default
    }
  }
  return resolved;
}
