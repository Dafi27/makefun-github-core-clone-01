// store.ts — the forge's in-memory model.
//
// One trial, one fresh server, so nothing is persisted: repos, refs, issues, pull requests and
// the git object store all live in memory. The object store is GLOBAL and content-addressed
// (an object id is its content's SHA-1), while reachability is always computed from the repo's
// own refs, so two repos can share objects without leaking each other's history.
//
// Determinism: every generated commit carries a fixed timestamp and a fixed author, every issue
// and pull request a timestamp derived from its insertion sequence, so two runs on the same
// instance leave the same state.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitproto.ts';
import { SCENARIO_EPOCH_SEC } from './scenario.ts';

/** The author/committer line every REST-generated commit carries. */
export const REST_AUTHOR = 'Dafi27 <80374032+Dafi27@users.noreply.github.com>';
/** The fixed timestamp every REST-generated commit carries (2025-01-01T00:00:00Z). */
export const REST_TIMESTAMP = SCENARIO_EPOCH_SEC;
/** The empty tree's id, used when a repo's last file is deleted. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly seq: number;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly seq: number;
  readonly comments: Comment[];
}

export interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly seq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  /** refs/heads/<branch> and refs/tags/<tag> → commit/tag oid. */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
}

/** A file in a flattened tree: path → blob oid. */
export type FileMap = Map<string, { oid: string; mode: string }>;

/** Deterministic ISO timestamp for insertion sequence `seq` (one second apart). */
export function seqTimestamp(seq: number): string {
  return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString();
}

export class Store {
  /** The global content-addressed object store. */
  readonly objects = new Map<string, GitObject>();
  /** Repos by "owner/name". */
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  /** Global insertion counter; drives deterministic createdAt/updatedAt values. */
  private seqCounter = 0;

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  // ---------------------------------------------------------------- objects

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  // ---------------------------------------------------------------- trees

  /** Build the tree for a flat path → blob map, creating every intermediate directory. */
  treeFromFiles(files: FileMap): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, FileMap>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, file);
        }
      }
      for (const [dir, sub] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build('');
  }

  /** The entry at `segments` under tree `treeOid`, or null when it does not exist. */
  getPath(treeOid: string | null, segments: readonly string[]): { mode: string; oid: string; name: string } | null {
    if (treeOid === null || segments.length === 0) return null;
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = this.getObject(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return { mode: entry.mode, oid: entry.oid, name: entry.name };
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The directory entries under `segments` (empty segments = the root), or null. */
  listDir(treeOid: string | null, segments: readonly string[]): TreeEntry[] | null {
    if (treeOid === null) return null;
    let current = treeOid;
    for (const segment of segments) {
      const object = this.getObject(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const object = this.getObject(current);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /**
   * A new root-tree oid with `segments` set to `blobOid` (or deleted when `blobOid` is null).
   * Returns null when the tree becomes empty.
   */
  setPath(treeOid: string | null, segments: readonly string[], blobOid: string | null): string | null {
    const entries = treeOid === null ? [] : parseTree(this.getObject(treeOid)?.data ?? Buffer.alloc(0));
    const byName = new Map<string, TreeEntry>();
    for (const entry of entries) byName.set(entry.name, entry);
    const [head, ...rest] = segments;
    if (rest.length === 0) {
      if (blobOid === null) byName.delete(head);
      else byName.set(head, { mode: '100644', name: head, oid: blobOid });
    } else {
      const child = byName.get(head);
      const childTree = child && child.mode === '40000' ? child.oid : null;
      const next = this.setPath(childTree, rest, blobOid);
      if (next === null) byName.delete(head);
      else byName.set(head, { mode: '40000', name: head, oid: next });
    }
    const kept = [...byName.values()];
    if (kept.length === 0) return null;
    return this.putObject('tree', buildTree(kept));
  }

  /** Every file under tree `treeOid`, as path → {oid, mode}. */
  flattenTree(treeOid: string): FileMap {
    const out: FileMap = new Map();
    const walk = (oid: string, prefix: string): void => {
      const object = this.getObject(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else if (entry.mode !== '160000') out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  // ---------------------------------------------------------------- commits

  /** Create a commit object and store it; returns its oid. */
  createCommit(tree: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      message,
      author: REST_AUTHOR,
      committer: REST_AUTHOR,
      timestamp: REST_TIMESTAMP,
    });
    return this.putObject('commit', data);
  }

  /** The commit chain from `tip`, children before parents, duplicates removed. */
  commitChain(tip: string, limit?: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      const object = this.getObject(oid);
      if (!object || object.type !== 'commit') return;
      seen.add(oid);
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) visit(parent);
    };
    visit(tip);
    return limit === undefined ? out : out.slice(0, limit);
  }

  /** True when `ancestor` is `descendant` or reachable from it through parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.getObject(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The first common ancestor of `a` and `b` (breadth-first from `b`), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const object = this.getObject(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const object = this.getObject(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** Every object reachable from `roots` (per-repo reachability over the global store). */
  reachable(roots: Iterable<string>): Set<string> {
    return collectReachable(roots, (oid) => this.getObject(oid), { allowMissing: false });
  }

  // ---------------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Create a repo, or null when `owner/name` already exists. */
  createRepo(
    owner: string,
    name: string,
    options: { description?: string; private?: boolean; defaultBranch?: string } = {},
  ): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdSeq: this.nextSeq(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The viewer's repos, in creation order. */
  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------------- refs

  /** Resolve a ref name to a commit/tag oid. Accepts `refs/heads/x`, `heads/x`, or a bare branch name. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) {
      const object = this.getObject(ref);
      return object ? ref : null;
    }
    const candidates = [ref];
    if (!ref.startsWith('refs/')) {
      candidates.push(`refs/heads/${ref}`, `refs/tags/${ref}`);
    }
    for (const candidate of candidates) {
      const oid = repo.refs.get(candidate);
      if (oid !== undefined) return oid;
    }
    return null;
  }

  /** The tip commit oid of a branch, following annotated tags to their commit. */
  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return null;
    return this.peelToCommit(oid);
  }

  /** Follow annotated tags to the commit they point at; other oids pass through unchanged. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) return null;
      seen.add(current);
      const object = this.getObject(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
  }

  // ---------------------------------------------------------------- issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    const issue: Issue = {
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: this.nextSeq(),
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string; headSha: string; baseSha: string }): Pull {
    const pull: Pull = {
      number: repo.nextPull,
      title: input.title,
      body: input.body,
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      headSha: input.headSha,
      baseSha: input.baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nextSeq(),
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  // ---------------------------------------------------------------- diff / merge

  /** Line-diff summary between two blob contents (added/deleted lines, git-style). */
  static lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
    const aLines = before.toString('utf8').split('\n');
    const bLines = after.toString('utf8').split('\n');
    if (aLines.length > 0 && aLines[aLines.length - 1] === '') aLines.pop();
    if (bLines.length > 0 && bLines[bLines.length - 1] === '') bLines.pop();
    // Longest-common-subsequence length on line level (files here are small).
    const counts = new Map<string, number>();
    for (const line of bLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of aLines) {
      const remaining = counts.get(line) ?? 0;
      if (remaining > 0) {
        counts.set(line, remaining - 1);
        common += 1;
      }
    }
    return { additions: bLines.length - common, deletions: aLines.length - common };
  }

  /** The changed paths between two trees, with per-file add/delete line counts. */
  diffTrees(baseTree: string, headTree: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const data = this.getObject(b.oid)?.data ?? Buffer.alloc(0);
        out.push({ path, status: 'removed', additions: 0, deletions: data.toString('utf8').split('\n').filter((l) => l !== '').length });
      } else if (!b && h) {
        const data = this.getObject(h.oid)?.data ?? Buffer.alloc(0);
        out.push({ path, status: 'added', additions: data.toString('utf8').split('\n').filter((l) => l !== '').length, deletions: 0 });
      } else if (b && h && b.oid !== h.oid) {
        const before = this.getObject(b.oid)?.data ?? Buffer.alloc(0);
        const after = this.getObject(h.oid)?.data ?? Buffer.alloc(0);
        const { additions, deletions } = Store.lineDiff(before, after);
        out.push({ path, status: 'modified', additions, deletions });
      }
    }
    return out;
  }

  /** True when merging `headTree` onto `baseTree` (three-way against `mergeBaseTree`) conflicts. */
  hasMergeConflict(baseTree: string, headTree: string, mergeBaseTree: string): boolean {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const ancestor = this.flattenTree(mergeBaseTree);
    const paths = new Set([...base.keys(), ...head.keys(), ...ancestor.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const a = ancestor.get(path);
      const changedInHead = (h?.oid ?? null) !== (a?.oid ?? null);
      const changedInBase = (b?.oid ?? null) !== (a?.oid ?? null);
      if (changedInHead && changedInBase && (b?.oid ?? null) !== (h?.oid ?? null)) return true;
    }
    return false;
  }

  /** The tree that results from applying `headTree`'s changes (against `mergeBaseTree`) onto `baseTree`. */
  applyMerge(baseTree: string, headTree: string, mergeBaseTree: string): string {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const ancestor = this.flattenTree(mergeBaseTree);
    const result: FileMap = new Map(base);
    const paths = new Set([...head.keys(), ...ancestor.keys()]);
    for (const path of paths) {
      const h = head.get(path);
      const a = ancestor.get(path);
      const changedInHead = (h?.oid ?? null) !== (a?.oid ?? null);
      if (!changedInHead) continue;
      if (h) result.set(path, h);
      else result.delete(path);
    }
    return this.treeFromFiles(result);
  }

  /**
   * Squash-merge an open pull request onto its base branch: one commit on the base branch whose
   * tree is the three-way merge of the head's changes, then the PR closes as merged.
   * Returns the merge commit sha, or an error kind ('not-found' | 'conflict' | 'not-open').
   */
  squashMerge(repo: Repo, pull: Pull): { sha: string } | { error: 'not-found' | 'conflict' | 'not-open' } {
    if (pull.state !== 'open') return { error: 'not-open' };
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.peelToCommit(pull.headSha);
    if (baseTip === null || headTip === null) return { error: 'not-found' };
    const baseCommit = parseCommit(this.getObject(baseTip)!.data);
    const headCommit = parseCommit(this.getObject(headTip)!.data);
    const mergeBaseOid = this.mergeBase(baseTip, headTip);
    if (mergeBaseOid === null) return { error: 'conflict' };
    const mergeBaseCommit = parseCommit(this.getObject(mergeBaseOid)!.data);
    if (this.hasMergeConflict(baseCommit.tree, headCommit.tree, mergeBaseCommit.tree)) {
      return { error: 'conflict' };
    }
    const newTree = this.applyMerge(baseCommit.tree, headCommit.tree, mergeBaseCommit.tree);
    const sha = this.createCommit(newTree, [baseTip], pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = seqTimestamp(this.nextSeq());
    pull.mergeCommitSha = sha;
    return { sha };
  }
}
