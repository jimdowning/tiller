// store.mjs — append-only JSONL fact log with content/logical dedup.
//
// The log is the ONLY persistent state the classifier reads. Facts are never
// modified or deleted; corrections are `contradiction` facts (invariant I1).
// Dedup is what makes a tick idempotent: re-sensing unchanged GitHub state
// re-derives the same facts, which all dedup to no-ops.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalKey } from './schema.mjs';

export class FactStore {
  /** @param {string|null} path JSONL file, or null for in-memory (tests) */
  constructor(path = null) {
    this.path = path;
    this.facts = [];
    this.keys = new Set();
    this.seq = 0;
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const f = JSON.parse(line);
        this.facts.push(f);
        this.keys.add(canonicalKey(f));
        this.seq = Math.max(this.seq, (f.seq ?? 0) + 1);
      }
    }
  }

  /** Append one fact if novel. Returns the stored fact, or null if a dup. */
  append(fact) {
    const k = canonicalKey(fact);
    if (this.keys.has(k)) return null;
    const stored = { ...fact, seq: this.seq++ };
    this.keys.add(k);
    this.facts.push(stored);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(stored) + '\n');
    }
    return stored;
  }

  /** Append many; returns only the novel ones. */
  appendAll(facts) {
    const novel = [];
    for (const f of facts) {
      const s = this.append(f);
      if (s) novel.push(s);
    }
    return novel;
  }

  all() {
    return this.facts;
  }
}
