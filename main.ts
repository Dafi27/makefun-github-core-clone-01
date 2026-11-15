// forge — a GitHub-core clone: git hosting platform (REST v3, git smart HTTP,
// GraphQL, MCP) in one file, Node 22 stdlib only.
//
// Lifecycle: bind an ephemeral port, register it with the environment, serve
// until the environment says done, exit 0. The bearer token names the viewer:
// every repository the token creates belongs to that login, and every other
// owner is foreign. All timestamps come from a fixed clock so two runs leave
// identical state.

import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";

// ---------------------------------------------------------------- config

const TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? "";
const ENV_URL: string = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
let viewerLogin: string = TOKEN; // the token names the viewer; register may refine it

const ZERO_OID = "0000000000000000000000000000000000000000";
const EPOCH_MS = 1735689600000; // 2025-01-01T00:00:00Z
const EPOCH_SEC = 1735689600;
const DEFAULT_BRANCH = "main";
const AUTHOR_NAME = "forge";
const AUTHOR_EMAIL = "forge@example.invalid";
const VERSION = "1.0.0";

// ------------------------------------------------------- deterministic clock

let clockTick = 0;
function tickIso(): string {
  clockTick += 1;
  return new Date(EPOCH_MS + clockTick * 1000).toISOString();
}
function tickSec(): number {
  clockTick += 1;
  return EPOCH_SEC + clockTick;
}
let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}
let globalSeq = 0;
function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

// ------------------------------------------------------------------ utils

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}
function unb64(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}
function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}
function sha1hex(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

// ------------------------------------------------------------ git objects

// The object store is content-addressed and shared by every repository:
// an object is identified by its SHA-1, and reachability is always computed
// from a repository's own refs, so sharing the store cannot leak objects
// across repositories.
const objects = new Map<string, Buffer>();

function storeObject(type: string, body: Buffer): string {
  const head = Buffer.from(`${type} ${body.length}\0`, "utf8");
  const full = Buffer.concat([head, body]);
  const sha = sha1hex(full);
  objects.set(sha, full);
  return sha;
}

function objParts(buf: Buffer): { type: string; size: number; body: Buffer } {
  const nul = buf.indexOf(0);
  const head = buf.subarray(0, nul).toString("utf8");
  const sp = head.indexOf(" ");
  return { type: head.slice(0, sp), size: parseInt(head.slice(sp + 1), 10), body: buf.subarray(nul + 1) };
}

function objType(sha: string): string | null {
  const full = objects.get(sha);
  if (!full) return null;
  return objParts(full).type;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function makeBlob(content: Buffer): string {
  return storeObject("blob", content);
}

function makeTree(entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === "40000" ? `${a.name}/` : a.name;
    const bn = b.mode === "40000" ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.sha, "hex"));
  }
  return storeObject("tree", Buffer.concat(parts));
}

function parseTree(buf: Buffer): TreeEntry[] {
  const { body } = objParts(buf);
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < body.length) {
    const sp = body.indexOf(0x20, off);
    const nul = body.indexOf(0, sp);
    const mode = body.subarray(off, sp).toString("utf8");
    const name = body.subarray(sp + 1, nul).toString("utf8");
    const sha = body.subarray(nul + 1, nul + 21).toString("hex");
    out.push({ mode, name, sha });
    off = nul + 21;
  }
  return out;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function makeCommit(tree: string, parents: string[], ts: number, message: string): string {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${ts} +0000\n`;
  s += `committer ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${ts} +0000\n`;
  s += `\n${message}`;
  return storeObject("commit", Buffer.from(s, "utf8"));
}

function parseCommit(buf: Buffer): CommitInfo {
  const { body } = objParts(buf);
  const text = body.toString("utf8");
  const blank = text.indexOf("\n\n");
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : "";
  const parents: string[] = [];
  let tree = "";
  let author = "";
  let committer = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function makeTag(object: string, type: string, tag: string, ts: number, message: string): string {
  const s =
    `object ${object}\ntype ${type}\ntag ${tag}\n` +
    `tagger ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${ts} +0000\n\n${message}`;
  return storeObject("tag", Buffer.from(s, "utf8"));
}

function parseTag(buf: Buffer): { object: string; type: string; tag: string; message: string } {
  const { body } = objParts(buf);
  const text = body.toString("utf8");
  const blank = text.indexOf("\n\n");
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : "";
  let object = "";
  let type = "";
  let tag = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("object ")) object = line.slice(7);
    else if (line.startsWith("type ")) type = line.slice(5);
    else if (line.startsWith("tag ")) tag = line.slice(4);
  }
  return { object, type, tag, message };
}

// ------------------------------------------------------------------ packs

const PACK_TYPE_NUM: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAME: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

function writePack(shas: string[]): Buffer {
  const sorted = [...shas].sort();
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK", 0);
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  chunks.push(head);
  for (const sha of sorted) {
    const full = objects.get(sha);
    if (!full) continue;
    const { type, body } = objParts(full);
    const typeNum = PACK_TYPE_NUM[type];
    if (!typeNum) continue;
    const size = body.length;
    const hdr: number[] = [];
    let rest = size;
    hdr.push(((typeNum & 7) << 4) | (rest & 15) | (rest > 15 ? 0x80 : 0));
    rest >>= 4;
    while (rest > 0) {
      hdr.push((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0));
      rest >>= 7;
    }
    chunks.push(Buffer.from(hdr));
    // Fastest compression: the pack only has to be valid, not small.
    chunks.push(zlib.deflateSync(body, { level: 1 }));
  }
  const withoutTrailer = Buffer.concat(chunks);
  const trailer = crypto.createHash("sha1").update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

// Find the end of the zlib stream starting at off: the smallest prefix that
// inflates cleanly. inflateSync throws on a truncated stream and ignores
// trailing bytes, so the predicate is monotonic and a binary search lands
// exactly on the stream end.
function inflateAt(buf: Buffer, off: number): { data: Buffer; end: number } {
  let lo = off + 1;
  let hi = buf.length;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      zlib.inflateSync(buf.subarray(off, mid));
      ans = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (ans < 0) throw new Error("bad deflate stream in pack");
  return { data: zlib.inflateSync(buf.subarray(off, ans)), end: ans };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error("delta base size mismatch");
  const out: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      const chunk = base.subarray(cpOff, cpOff + cpSize);
      out.push(chunk);
      outLen += chunk.length;
    } else if (op > 0) {
      const chunk = delta.subarray(off, off + op);
      out.push(chunk);
      outLen += op;
      off += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  const res = Buffer.concat(out, outLen);
  if (res.length !== tgtSize) throw new Error("delta target size mismatch");
  return res;
}

// Parse a packfile (v2/v3, plain objects, OFS_DELTA and REF_DELTA), store
// every object, and return the SHAs it added. Delta bases resolve against
// objects already in the store or earlier entries in this same pack.
function readPack(buf: Buffer): string[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("not a packfile");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error("unsupported pack version");
  const count = buf.readUInt32BE(8);
  let off = 12;
  const added: string[] = [];
  const byOffset = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const entryStart = off;
    let b = buf[off++];
    const typeNum = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | null = null;
    let baseSha: string | null = null;
    if (typeNum === 6) {
      let byte = buf[off++];
      let baseOff = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[off++];
        baseOff = ((baseOff + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - baseOff;
    } else if (typeNum === 7) {
      baseSha = buf.subarray(off, off + 20).toString("hex");
      off += 20;
    }
    const { data, end } = inflateAt(buf, off);
    off = end;
    if (typeNum === 6 || typeNum === 7) {
      let baseFull: Buffer | undefined;
      if (baseOffset !== null) {
        const baseEntrySha = byOffset.get(baseOffset);
        if (baseEntrySha) baseFull = objects.get(baseEntrySha);
      } else if (baseSha) {
        baseFull = objects.get(baseSha);
      }
      if (!baseFull) throw new Error("delta base not found");
      const { type: baseType, body: baseBody } = objParts(baseFull);
      const result = applyDelta(baseBody, data);
      const sha = storeObject(baseType, result);
      byOffset.set(entryStart, sha);
      added.push(sha);
    } else {
      const typeName = PACK_TYPE_NAME[typeNum];
      if (!typeName) throw new Error(`bad pack entry type ${typeNum}`);
      if (data.length !== size) throw new Error("pack entry size mismatch");
      const sha = storeObject(typeName, data);
      byOffset.set(entryStart, sha);
      added.push(sha);
    }
  }
  return added;
}

// Every object reachable from the given tips (commits, their trees and
// blobs, peeled tags).
function reachableFrom(tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const full = objects.get(sha);
    if (!full) continue;
    seen.add(sha);
    const { type } = objParts(full);
    if (type === "commit") {
      const c = parseCommit(full);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (type === "tree") {
      for (const e of parseTree(full)) stack.push(e.sha);
    } else if (type === "tag") {
      stack.push(parseTag(full).object);
    }
  }
  return seen;
}

// The objects a shallow fetch of the given tips at the given depth must
// send, minus what the client already holds. Generations are counted from
// the tips (tip = 0). The boundary is every included commit whose parent is
// not included; a held commit whose parent is now included stops being
// shallow.
function shallowPlan(
  tips: string[],
  depth: number,
  held: Set<string>,
): { send: Set<string>; boundary: Set<string>; unshallow: Set<string> } {
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((t) => [t, 0] as [string, number]);
  while (queue.length > 0) {
    const [sha, g] = queue.shift() as [string, number];
    if (gen.has(sha)) continue;
    const full = objects.get(sha);
    if (!full || objParts(full).type !== "commit") continue;
    gen.set(sha, g);
    if (g + 1 < depth) {
      for (const p of parseCommit(full).parents) queue.push([p, g + 1]);
    }
  }
  const included = new Set<string>([...gen.keys()].filter((s) => (gen.get(s) as number) < depth));
  const boundary = new Set<string>();
  for (const sha of included) {
    const full = objects.get(sha);
    if (!full) continue;
    const parents = parseCommit(full).parents;
    if (parents.every((p) => !included.has(p))) boundary.add(sha);
  }
  const unshallow = new Set<string>();
  for (const h of held) {
    if (!included.has(h)) continue;
    if (!boundary.has(h)) unshallow.add(h);
  }
  // Everything the client already holds: each held commit plus its tree.
  const heldObjects = new Set<string>();
  for (const h of held) {
    if (objType(h) === "commit") {
      const c = parseCommit(objects.get(h) as Buffer);
      heldObjects.add(h);
      for (const o of reachableFrom([c.tree])) heldObjects.add(o);
    } else {
      heldObjects.add(h);
    }
  }
  const send = new Set<string>();
  for (const sha of included) {
    send.add(sha);
    const full = objects.get(sha);
    if (!full) continue;
    const c = parseCommit(full);
    for (const o of reachableFrom([c.tree])) send.add(o);
  }
  for (const h of heldObjects) send.delete(h);
  return { send, boundary, unshallow };
}

// True when anc is an ancestor of (or equal to) desc. Walks commit parents
// only and stops as soon as the ancestor is found.
function isAncestor(anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (sha === anc) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const full = objects.get(sha);
    if (!full || objParts(full).type !== "commit") continue;
    for (const p of parseCommit(full).parents) stack.push(p);
  }
  return false;
}

// The commit ancestors of a tip (commits only, no trees or blobs).
function commitAncestors(tip: string): Set<string> {
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const full = objects.get(sha);
    if (!full || objParts(full).type !== "commit") continue;
    out.add(sha);
    for (const p of parseCommit(full).parents) stack.push(p);
  }
  return out;
}

// The merge-base of two commits: the nearest common ancestor, found by
// walking from the second tip outward and taking the first commit the first
// tip can also reach.
function mergeBase(a: string, b: string): string | null {
  const ancA = commitAncestors(a);
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancA.has(sha) && objType(sha) === "commit") return sha;
    const full = objects.get(sha);
    if (!full || objParts(full).type !== "commit") continue;
    for (const p of parseCommit(full).parents) queue.push(p);
  }
  return null;
}

// ------------------------------------------------------------------- store

interface LabelItem {
  id: number;
  name: string;
  color: string;
}
interface CommentItem {
  id: number;
  nodeId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
interface IssueItem {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: CommentItem[];
}
interface PullItem {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}
interface Repo {
  id: number;
  nodeId: string;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  branches: Map<string, string>;
  tags: Map<string, { sha: string; type: string }>;
  issues: Map<number, IssueItem>;
  labels: Map<string, LabelItem>;
  pulls: Map<number, PullItem>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  nextLabelId: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const id = nextRepoId++;
  const now = tickIso();
  const repo: Repo = {
    id,
    nodeId: b64(`repo:${owner}/${name}`),
    name,
    owner,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: now,
    updatedAt: now,
    branches: new Map(),
    tags: new Map(),
    issues: new Map(),
    labels: new Map(),
    pulls: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextCommentId: 1,
    nextLabelId: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.branches.get(branch) ?? null;
}

function treeAtBranch(repo: Repo, branch: string): string | null {
  const tip = branchTip(repo, branch);
  if (!tip) return null;
  const full = objects.get(tip);
  if (!full) return null;
  return parseCommit(full).tree;
}

// ------------------------------------------------------------ tree editing

function treeEntries(treeSha: string | null): TreeEntry[] {
  if (!treeSha) return [];
  const full = objects.get(treeSha);
  if (!full) return [];
  return parseTree(full);
}

function readPath(treeSha: string | null, parts: string[]): { sha: string; mode: string } | null {
  let cur = treeSha;
  for (let i = 0; i < parts.length; i++) {
    if (!cur) return null;
    const e = treeEntries(cur).find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return { sha: e.sha, mode: e.mode };
    if (e.mode !== "40000") return null;
    cur = e.sha;
  }
  return null;
}

function writePath(treeSha: string | null, parts: string[], blobSha: string): string {
  const entries = treeEntries(treeSha);
  const first = parts[0];
  const rest = parts.slice(1);
  if (rest.length === 0) {
    const next = entries.filter((e) => e.name !== first);
    next.push({ mode: "100644", name: first, sha: blobSha });
    return makeTree(next);
  }
  const sub = entries.find((e) => e.name === first);
  const subTree = sub && sub.mode === "40000" ? sub.sha : null;
  const newSub = writePath(subTree, rest, blobSha);
  const next = entries.filter((e) => e.name !== first);
  next.push({ mode: "40000", name: first, sha: newSub });
  return makeTree(next);
}

function deletePath(treeSha: string | null, parts: string[]): string | null {
  if (!treeSha) return null;
  const entries = treeEntries(treeSha);
  const first = parts[0];
  const rest = parts.slice(1);
  if (rest.length === 0) {
    const next = entries.filter((e) => e.name !== first);
    if (next.length === 0) return null;
    return makeTree(next);
  }
  const sub = entries.find((e) => e.name === first);
  if (!sub || sub.mode !== "40000") return treeSha;
  const newSub = deletePath(sub.sha, rest);
  const next = entries.filter((e) => e.name !== first);
  if (newSub) next.push({ mode: "40000", name: first, sha: newSub });
  if (next.length === 0) return null;
  return makeTree(next);
}

// A tree flattened to path -> {sha, mode} for files only.
function flattenTree(treeSha: string | null, prefix = ""): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  if (!treeSha) return out;
  for (const e of treeEntries(treeSha)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === "40000") {
      for (const [k, v] of flattenTree(e.sha, p)) out.set(k, v);
    } else {
      out.set(p, { sha: e.sha, mode: e.mode });
    }
  }
  return out;
}

// Rebuild a tree from a flat path -> blob sha map.
function buildTree(flat: Map<string, string>): string {
  if (flat.size === 0) return makeTree([]);
  const groups = new Map<string, Map<string, string>>();
  const files: Array<{ name: string; sha: string }> = [];
  for (const [path, sha] of flat) {
    const slash = path.indexOf("/");
    if (slash < 0) {
      files.push({ name: path, sha });
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let g = groups.get(dir);
      if (!g) {
        g = new Map();
        groups.set(dir, g);
      }
      g.set(rest, sha);
    }
  }
  const entries: TreeEntry[] = [];
  for (const f of files) entries.push({ mode: "100644", name: f.name, sha: f.sha });
  for (const [dir, sub] of groups) {
    entries.push({ mode: "40000", name: dir, sha: buildTree(sub) });
  }
  return makeTree(entries);
}

function blobText(sha: string): string {
  const full = objects.get(sha);
  if (!full) return "";
  return objParts(full).body.toString("utf8");
}

// Line additions/deletions by multiset difference; a file whose bytes
// changed but whose lines are the same bag still counts as one addition so
// a changed file never reports zero additions.
function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  return { additions, deletions };
}

interface FileChange {
  filename: string;
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

function diffTrees(baseTree: string | null, headTree: string | null): FileChange[] {
  const base = flattenTree(baseTree);
  const head = flattenTree(headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const p of [...paths].sort()) {
    const b = base.get(p);
    const h = head.get(p);
    if (b && !h) {
      const { deletions } = lineCounts(blobText(b.sha), "");
      out.push({ filename: p, path: p, status: "removed", additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const { additions } = lineCounts("", blobText(h.sha));
      out.push({ filename: p, path: p, status: "added", additions, deletions: 0, changes: additions });
    } else if (b && h && b.sha !== h.sha) {
      let { additions, deletions } = lineCounts(blobText(b.sha), blobText(h.sha));
      if (additions === 0 && deletions === 0) additions = 1;
      out.push({ filename: p, path: p, status: "modified", additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// File-granularity three-way merge: base is the merge-base tree, head is
// the branch being merged, tip is the branch being merged into. A path both
// sides changed differently is a conflict.
function mergeTrees(
  baseTree: string | null,
  headTree: string | null,
  tipTree: string | null,
): { tree: string; conflict: boolean } {
  const base = flattenTree(baseTree);
  const head = flattenTree(headTree);
  const tip = flattenTree(tipTree);
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...tip.keys()]);
  const result = new Map<string, string>();
  let conflict = false;
  for (const p of paths) {
    const b = base.get(p)?.sha ?? null;
    const h = head.get(p)?.sha ?? null;
    const t = tip.get(p)?.sha ?? null;
    if (h === t) {
      if (t !== null) result.set(p, t);
    } else if (b === t) {
      if (h !== null) result.set(p, h);
    } else if (b === h) {
      if (t !== null) result.set(p, t);
    } else {
      conflict = true;
    }
  }
  if (conflict) return { tree: "", conflict: true };
  return { tree: buildTree(result), conflict: false };
}

// The merge-base commit's tree, the head tip's tree and the base tip's tree
// for a pull request; null when the branches share no history.
function prMergeInputs(repo: Repo, pr: PullItem): { baseTree: string; headTree: string; tipTree: string } | null {
  const baseSha = branchTip(repo, pr.baseRef);
  if (!baseSha) return null;
  const base = mergeBase(pr.headSha, baseSha);
  if (!base) return null;
  const baseFull = objects.get(base);
  const headFull = objects.get(pr.headSha);
  const tipFull = objects.get(baseSha);
  if (!baseFull || !headFull || !tipFull) return null;
  return {
    baseTree: parseCommit(baseFull).tree,
    headTree: parseCommit(headFull).tree,
    tipTree: parseCommit(tipFull).tree,
  };
}

function prHasConflict(repo: Repo, pr: PullItem): boolean {
  const inputs = prMergeInputs(repo, pr);
  if (!inputs) return true;
  return mergeTrees(inputs.baseTree, inputs.headTree, inputs.tipTree).conflict;
}

// All commits reachable from a tip, newest first by creation sequence.
// Each commit remembers the order it was created in via a side table.
const commitSeq = new Map<string, number>();
function noteCommitSeq(sha: string): void {
  if (!commitSeq.has(sha)) commitSeq.set(sha, nextSeq());
}

function commitsFromTip(tip: string): Array<{ sha: string; message: string }> {
  const seen = new Set<string>();
  const stack = [tip];
  const found: string[] = [];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const full = objects.get(sha);
    if (!full || objParts(full).type !== "commit") continue;
    seen.add(sha);
    found.push(sha);
    for (const p of parseCommit(full).parents) stack.push(p);
  }
  found.sort((a, b) => (commitSeq.get(b) ?? 0) - (commitSeq.get(a) ?? 0));
  return found.map((sha) => ({ sha, message: parseCommit(objects.get(sha) as Buffer).message }));
}

// ------------------------------------------------------------ repo views

function repoJson(repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: "User" },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    git_url: `${base}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === "open").length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? "private" : "public",
  };
}

function issueJson(repo: Repo, issue: IssueItem, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: l?.id ?? 0, name, color: l?.color ?? "000000", description: "" };
    }),
    user: { login: repo.owner, id: 1000, type: "User" },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === "closed" ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: PullItem, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  return {
    id: pr.id,
    node_id: pr.nodeId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    head: { ref: pr.headRef, sha: prHeadSha(repo, pr), label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: prBaseSha(repo, pr), label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    mergeable: pr.state === "open" ? !prHasConflict(repo, pr) : null,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    user: { login: repo.owner, id: 1000, type: "User" },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === "closed" ? pr.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

// ------------------------------------------------------------- http plumbing

function sendJson(res: http.ServerResponse, status: number, obj: unknown, extra?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "x-github-request-id": nextRequestId(),
    "content-length": String(body.length),
    ...(extra ?? {}),
  });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      total += c.length;
      if (total > 64 * 1024 * 1024) {
        failed = true;
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

function parseJson(buf: Buffer): { ok: boolean; value?: unknown } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString("utf8")) };
  } catch {
    return { ok: false };
  }
}

// The bearer token names the viewer. A wrong or missing token is 401.
// With no token configured, the first bearer token seen names the viewer.
function authed(req: http.IncomingMessage): boolean {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) return false;
  const tok = h.slice(7).trim();
  if (tok.length === 0) return false;
  if (TOKEN.length > 0) return tok === TOKEN;
  if (!viewerLogin) viewerLogin = tok;
  return true;
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (authed(req)) return true;
  sendError(res, 401, "Unauthorized");
  return false;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number; total: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get("per_page") ?? "30", 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
  const total = items.length;
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum, total };
}

function nextLink(req: http.IncomingMessage, perPage: number, pageNum: number, total: number): string | null {
  if (pageNum * perPage >= total) return null;
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  url.searchParams.set("page", String(pageNum + 1));
  url.searchParams.set("per_page", String(perPage));
  return `<${url.toString()}>; rel="next"`;
}

// The pull request's live head/base tips (branches move; the stored SHAs
// are the fallback when a branch is gone).
function prHeadSha(repo: Repo, pr: PullItem): string {
  return branchTip(repo, pr.headRef) ?? pr.headSha;
}
function prBaseSha(repo: Repo, pr: PullItem): string {
  return branchTip(repo, pr.baseRef) ?? pr.baseSha;
}

function parseIdent(line: string): { name: string; email: string; ts: number } {
  const m = /^(.+?) <(.+?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!m) return { name: AUTHOR_NAME, email: AUTHOR_EMAIL, ts: EPOCH_SEC };
  return { name: m[1], email: m[2], ts: parseInt(m[3], 10) };
}

// ------------------------------------------------------------------ REST v3

let nextGlobalIssueId = 1;
let nextGlobalPrId = 1;

async function handleRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parts: string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
): Promise<void> {
  const method = req.method ?? "GET";
  const obj = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const bool = (v: unknown): boolean => v === true;

  // GET /api/v3/
  if (parts.length === 0) {
    if (method !== "GET") return sendError(res, 404, "Not Found");
    return sendJson(res, 200, {}, { "x-oauth-scopes": "repo, read:org" });
  }
  if (parts.length === 1 && parts[0] === "meta") {
    if (method !== "GET") return sendError(res, 404, "Not Found");
    return sendJson(res, 200, { installed_version: VERSION });
  }
  if (parts.length === 1 && parts[0] === "user") {
    if (method !== "GET") return sendError(res, 404, "Not Found");
    return sendJson(res, 200, {
      login: viewerLogin,
      id: 1000,
      node_id: b64(`user:${viewerLogin}`),
      type: "User",
      site_admin: false,
      name: viewerLogin,
      email: `${viewerLogin}@example.invalid`,
      html_url: `https://github.com/${viewerLogin}`,
      url: `http://${host}/api/v3/users/${viewerLogin}`,
    });
  }
  // /user/repos
  if (parts.length === 2 && parts[0] === "user" && parts[1] === "repos") {
    if (method === "POST") {
      const name = str(obj.name);
      if (!name) return sendError(res, 422, "name is required");
      if (getRepo(viewerLogin, name)) return sendError(res, 422, "Repository already exists");
      const repo = createRepoRecord(viewerLogin, name, str(obj.description), bool(obj.private));
      return sendJson(res, 201, repoJson(repo, host));
    }
    if (method === "GET") {
      const all = [...repos.values()]
        .filter((r) => r.owner === viewerLogin)
        .sort((a, b) => a.id - b.id);
      const { page, perPage, pageNum, total } = paginate(all, query);
      const link = nextLink(req, perPage, pageNum, total);
      return sendJson(res, 200, page.map((r) => repoJson(r, host)), link ? { link } : undefined);
    }
    return sendError(res, 404, "Not Found");
  }

  // /repos/{owner}/{name}[...]
  if (parts.length >= 3 && parts[0] === "repos") {
    const owner = parts[1];
    const name = parts[2];
    // A repository belongs to the login the token names; the same name
    // under any other owner is 404, never 403.
    if (owner !== viewerLogin) return sendError(res, 404, "Not Found");
    const rest = parts.slice(3);
    const repo = getRepo(owner, name);

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (!repo) return sendError(res, 404, "Not Found");
      if (method === "GET") return sendJson(res, 200, repoJson(repo, host));
      if (method === "PATCH") {
        if (typeof obj.description === "string") repo.description = obj.description;
        if (typeof obj.private === "boolean") repo.isPrivate = obj.private;
        repo.updatedAt = tickIso();
        return sendJson(res, 200, repoJson(repo, host));
      }
      if (method === "DELETE") {
        repos.delete(repoKey(owner, name));
        res.writeHead(204, { "x-github-request-id": nextRequestId() });
        return res.end();
      }
      return sendError(res, 404, "Not Found");
    }
    if (!repo) return sendError(res, 404, "Not Found");

    // /repos/{o}/{r}/git/refs
    if (rest.length >= 2 && rest[0] === "git" && rest[1] === "refs") {
      if (method === "POST" && rest.length === 2) {
        const ref = str(obj.ref);
        const sha = str(obj.sha);
        if (!ref.startsWith("refs/heads/") || !isHex40(sha) || !objects.has(sha)) {
          return sendError(res, 422, "Invalid ref or sha");
        }
        const branch = ref.slice("refs/heads/".length);
        if (repo.branches.has(branch)) return sendError(res, 422, "Reference already exists");
        repo.branches.set(branch, sha);
        repo.updatedAt = tickIso();
        return sendJson(res, 201, {
          ref,
          node_id: b64(`ref:${owner}/${name}/${ref}`),
          url: `http://${host}/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
          object: { sha, type: objType(sha) ?? "commit", url: "" },
        });
      }
      if (method === "GET" && rest.length >= 3 && rest[2] === "heads") {
        const branch = rest.slice(3).join("/");
        const sha = repo.branches.get(branch);
        if (!sha) return sendError(res, 404, "Not Found");
        return sendJson(res, 200, {
          ref: `refs/heads/${branch}`,
          node_id: b64(`ref:${owner}/${name}/refs/heads/${branch}`),
          url: `http://${host}/api/v3/repos/${owner}/${name}/git/refs/heads/${branch}`,
          object: { sha, type: "commit", url: "" },
        });
      }
      return sendError(res, 404, "Not Found");
    }

    // /repos/{o}/{r}/branches
    if (rest.length >= 1 && rest[0] === "branches") {
      if (method === "GET" && rest.length === 1) {
        const list = [...repo.branches.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([bname, sha]) => ({
            name: bname,
            commit: { sha, url: `http://${host}/api/v3/repos/${owner}/${name}/commits/${sha}` },
            protected: false,
          }));
        return sendJson(res, 200, list);
      }
      if (method === "GET" && rest.length >= 2) {
        const branch = rest.slice(1).join("/");
        const sha = repo.branches.get(branch);
        if (!sha) return sendError(res, 404, "Not Found");
        return sendJson(res, 200, {
          name: branch,
          commit: { sha, url: `http://${host}/api/v3/repos/${owner}/${name}/commits/${sha}` },
          protected: false,
        });
      }
      return sendError(res, 404, "Not Found");
    }

    // /repos/{o}/{r}/commits
    if (rest.length >= 1 && rest[0] === "commits") {
      if (method !== "GET") return sendError(res, 404, "Not Found");
      const ref = query.get("sha") ?? repo.defaultBranch;
      let tip: string | null = null;
      if (repo.branches.has(ref)) tip = repo.branches.get(ref) as string;
      else if (isHex40(ref) && objects.has(ref)) tip = ref;
      if (!tip) return sendJson(res, 200, []);
      const list = commitsFromTip(tip).map(({ sha }) => {
        const c = parseCommit(objects.get(sha) as Buffer);
        const a = parseIdent(c.author);
        const cm = parseIdent(c.committer);
        return {
          sha,
          node_id: b64(`commit:${owner}/${name}/${sha}`),
          commit: {
            message: c.message,
            author: { name: a.name, email: a.email, date: new Date(a.ts * 1000).toISOString() },
            committer: { name: cm.name, email: cm.email, date: new Date(cm.ts * 1000).toISOString() },
          },
          author: { login: viewerLogin, id: 1000, type: "User" },
          committer: { login: viewerLogin, id: 1000, type: "User" },
          parents: c.parents.map((p) => ({ sha: p })),
          url: `http://${host}/api/v3/repos/${owner}/${name}/commits/${sha}`,
          html_url: `https://github.com/${owner}/${name}/commit/${sha}`,
        };
      });
      return sendJson(res, 200, list);
    }

    // /repos/{o}/{r}/contents[/{path}]
    if (rest.length >= 1 && rest[0] === "contents") {
      const pathParts = rest.slice(1);
      const branch = str(query.get("ref") ?? "") || repo.defaultBranch;
      if (method === "GET") {
        const tree = treeAtBranch(repo, branch);
        if (pathParts.length === 0) {
          // Root directory listing.
          const entries = treeEntries(tree).map((e) => ({
            type: e.mode === "40000" ? "dir" : "file",
            name: e.name,
            path: e.name,
            sha: e.sha,
            size: e.mode === "40000" ? 0 : objParts(objects.get(e.sha) as Buffer).size,
            url: `http://${host}/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(e.name)}`,
            html_url: `https://github.com/${owner}/${name}/blob/${branch}/${e.name}`,
          }));
          return sendJson(res, 200, entries);
        }
        const found = readPath(tree, pathParts);
        if (!found) return sendError(res, 404, "Not Found");
        const joined = pathParts.join("/");
        if (found.mode === "40000") {
          const entries = treeEntries(found.sha).map((e) => ({
            type: e.mode === "40000" ? "dir" : "file",
            name: e.name,
            path: `${joined}/${e.name}`,
            sha: e.sha,
            size: e.mode === "40000" ? 0 : objParts(objects.get(e.sha) as Buffer).size,
            url: `http://${host}/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(joined)}/${encodeURIComponent(e.name)}`,
            html_url: `https://github.com/${owner}/${name}/blob/${branch}/${joined}/${e.name}`,
          }));
          return sendJson(res, 200, entries);
        }
        const full = objects.get(found.sha) as Buffer;
        const { body } = objParts(full);
        return sendJson(res, 200, {
          type: "file",
          encoding: "base64",
          size: body.length,
          name: pathParts[pathParts.length - 1],
          path: joined,
          content: body.toString("base64"),
          sha: found.sha,
          url: `http://${host}/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(joined)}`,
          html_url: `https://github.com/${owner}/${name}/blob/${branch}/${joined}`,
          download_url: `http://${host}/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(joined)}`,
        });
      }
      if (method === "PUT") {
        if (pathParts.length === 0) return sendError(res, 422, "path is required");
        const message = str(obj.message) || `Update ${pathParts.join("/")}`;
        const contentB64 = str(obj.content);
        if (!contentB64) return sendError(res, 422, "content is required");
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, "base64");
        } catch {
          return sendError(res, 400, "content is not valid base64");
        }
        const targetBranch = str(obj.branch) || repo.defaultBranch;
        let tip = branchTip(repo, targetBranch);
        if (!tip && repo.branches.size > 0) {
          // A named branch that does not exist starts at the default tip.
          const defTip = branchTip(repo, repo.defaultBranch);
          if (defTip) {
            repo.branches.set(targetBranch, defTip);
            tip = defTip;
          }
        }
        const tree = tip ? parseCommit(objects.get(tip) as Buffer).tree : null;
        const current = readPath(tree, pathParts);
        const givenSha = str(obj.sha);
        if (current) {
          if (givenSha && givenSha !== current.sha) return sendError(res, 409, "sha does not match");
        } else if (givenSha) {
          return sendError(res, 422, "sha given for a file that does not exist");
        }
        const blobSha = makeBlob(content);
        const newTree = writePath(tree, pathParts, blobSha);
        const ts = tickSec();
        const commitSha = makeCommit(newTree, tip ? [tip] : [], ts, message);
        noteCommitSeq(commitSha);
        repo.branches.set(targetBranch, commitSha);
        repo.updatedAt = tickIso();
        return sendJson(res, current ? 200 : 201, {
          content: {
            name: pathParts[pathParts.length - 1],
            path: pathParts.join("/"),
            sha: blobSha,
            size: content.length,
            encoding: "base64",
            url: `http://${host}/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(pathParts.join("/"))}`,
          },
          commit: { sha: commitSha, message },
        });
      }
      if (method === "DELETE") {
        if (pathParts.length === 0) return sendError(res, 422, "path is required");
        const targetBranch = str(obj.branch) || repo.defaultBranch;
        const tip = branchTip(repo, targetBranch);
        if (!tip) return sendError(res, 404, "Not Found");
        const tree = parseCommit(objects.get(tip) as Buffer).tree;
        const current = readPath(tree, pathParts);
        if (!current) return sendError(res, 404, "Not Found");
        const givenSha = str(obj.sha);
        if (givenSha && givenSha !== current.sha) return sendError(res, 409, "sha does not match");
        const newTree = deletePath(tree, pathParts) ?? makeTree([]);
        const ts = tickSec();
        const message = str(obj.message) || `Delete ${pathParts.join("/")}`;
        const commitSha = makeCommit(newTree, [tip], ts, message);
        noteCommitSeq(commitSha);
        repo.branches.set(targetBranch, commitSha);
        repo.updatedAt = tickIso();
        return sendJson(res, 200, { commit: { sha: commitSha, message }, content: null });
      }
      return sendError(res, 404, "Not Found");
    }

    // /repos/{o}/{r}/labels
    if (rest.length >= 1 && rest[0] === "labels") {
      if (method === "GET" && rest.length === 1) {
        return sendJson(
          res,
          200,
          [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: "" })),
        );
      }
      if (method === "POST" && rest.length === 1) {
        const name = str(obj.name);
        if (!name) return sendError(res, 422, "name is required");
        if (repo.labels.has(name)) return sendError(res, 422, "Label already exists");
        const label: LabelItem = { id: repo.nextLabelId++, name, color: str(obj.color) || "000000" };
        repo.labels.set(name, label);
        return sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: "" });
      }
      return sendError(res, 404, "Not Found");
    }

    // /repos/{o}/{r}/issues
    if (rest.length >= 1 && rest[0] === "issues") {
      if (rest.length === 1) {
        if (method === "POST") {
          const title = str(obj.title);
          if (!title) return sendError(res, 422, "title is required");
          const wanted: string[] = Array.isArray(obj.labels) ? (obj.labels as unknown[]).map(String) : [];
          for (const l of wanted) {
            if (!repo.labels.has(l)) return sendError(res, 422, `Label does not exist: ${l}`);
          }
          const number = repo.nextIssue++;
          const now = tickIso();
          const issue: IssueItem = {
            id: nextGlobalIssueId++,
            nodeId: b64(`issue:${owner}/${name}/${number}`),
            number,
            title,
            body: str(obj.body),
            state: "open",
            labels: wanted,
            createdSeq: nextSeq(),
            createdAt: now,
            updatedAt: now,
            comments: [],
          };
          repo.issues.set(number, issue);
          repo.updatedAt = tickIso();
          return sendJson(res, 201, issueJson(repo, issue, host));
        }
        if (method === "GET") {
          const state = query.get("state") ?? "open";
          const direction = query.get("direction") ?? "desc";
          let list = [...repo.issues.values()];
          if (state === "open") list = list.filter((i) => i.state === "open");
          else if (state === "closed") list = list.filter((i) => i.state === "closed");
          list.sort((a, b) =>
            direction === "asc" ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
          );
          const { page, perPage, pageNum, total } = paginate(list, query);
          const link = nextLink(req, perPage, pageNum, total);
          return sendJson(res, 200, page.map((i) => issueJson(repo, i, host)), link ? { link } : undefined);
        }
        return sendError(res, 404, "Not Found");
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return sendError(res, 404, "Not Found");
      const issue = repo.issues.get(num);
      if (!issue) return sendError(res, 404, "Not Found");
      if (rest.length === 2) {
        if (method === "GET") return sendJson(res, 200, issueJson(repo, issue, host));
        if (method === "PATCH") {
          if (typeof obj.state === "string" && (obj.state === "open" || obj.state === "closed")) {
            issue.state = obj.state;
          }
          if (typeof obj.title === "string") issue.title = obj.title;
          if (typeof obj.body === "string") issue.body = obj.body;
          issue.updatedAt = tickIso();
          return sendJson(res, 200, issueJson(repo, issue, host));
        }
        return sendError(res, 404, "Not Found");
      }
      if (rest.length === 3 && rest[2] === "comments") {
        if (method === "GET") {
          return sendJson(
            res,
            200,
            issue.comments.map((c) => ({
              id: c.id,
              node_id: c.nodeId,
              body: c.body,
              user: { login: viewerLogin, id: 1000, type: "User" },
              created_at: c.createdAt,
              updated_at: c.updatedAt,
              html_url: `https://github.com/${owner}/${name}/issues/${num}#issuecomment-${c.id}`,
              url: `http://${host}/api/v3/repos/${owner}/${name}/issues/${num}/comments/${c.id}`,
            })),
          );
        }
        if (method === "POST") {
          const b = str(obj.body);
          if (!b) return sendError(res, 422, "body is required");
          const now = tickIso();
          const comment: CommentItem = {
            id: repo.nextCommentId++,
            nodeId: b64(`comment:${owner}/${name}/${num}/${repo.nextCommentId - 1}`),
            body: b,
            createdAt: now,
            updatedAt: now,
          };
          issue.comments.push(comment);
          issue.updatedAt = tickIso();
          return sendJson(res, 201, {
            id: comment.id,
            node_id: comment.nodeId,
            body: comment.body,
            user: { login: viewerLogin, id: 1000, type: "User" },
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
            html_url: `https://github.com/${owner}/${name}/issues/${num}#issuecomment-${comment.id}`,
            url: `http://${host}/api/v3/repos/${owner}/${name}/issues/${num}/comments/${comment.id}`,
          });
        }
        return sendError(res, 404, "Not Found");
      }
      return sendError(res, 404, "Not Found");
    }

    // /repos/{o}/{r}/pulls
    if (rest.length >= 1 && rest[0] === "pulls") {
      if (rest.length === 1) {
        if (method === "POST") {
          const head = str(obj.head);
          const base = str(obj.base);
          const title = str(obj.title);
          if (!head || !base || !title) return sendError(res, 422, "head, base and title are required");
          const headSha = branchTip(repo, head);
          const baseSha = branchTip(repo, base);
          if (!headSha || !baseSha) return sendError(res, 422, "head or base branch does not exist");
          const number = repo.nextPull++;
          const now = tickIso();
          const pr: PullItem = {
            id: nextGlobalPrId++,
            nodeId: b64(`pr:${owner}/${name}/${number}`),
            number,
            title,
            body: str(obj.body),
            state: "open",
            merged: false,
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            mergeCommitSha: null,
            mergedAt: null,
            createdSeq: nextSeq(),
            createdAt: now,
            updatedAt: now,
          };
          repo.pulls.set(number, pr);
          repo.updatedAt = tickIso();
          return sendJson(res, 201, pullJson(repo, pr, host));
        }
        if (method === "GET") {
          const state = query.get("state") ?? "open";
          let list = [...repo.pulls.values()];
          if (state === "open") list = list.filter((p) => p.state === "open");
          else if (state === "closed") list = list.filter((p) => p.state === "closed");
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, perPage, pageNum, total } = paginate(list, query);
          const link = nextLink(req, perPage, pageNum, total);
          return sendJson(res, 200, page.map((p) => pullJson(repo, p, host)), link ? { link } : undefined);
        }
        return sendError(res, 404, "Not Found");
      }
      const num = parseInt(rest[1], 10);
      if (!Number.isInteger(num)) return sendError(res, 404, "Not Found");
      const pr = repo.pulls.get(num);
      if (!pr) return sendError(res, 404, "Not Found");
      if (rest.length === 2) {
        if (method === "GET") return sendJson(res, 200, pullJson(repo, pr, host));
        return sendError(res, 404, "Not Found");
      }
      if (rest.length === 3 && rest[2] === "files") {
        if (method !== "GET") return sendError(res, 404, "Not Found");
        const inputs = prMergeInputs(repo, pr);
        if (!inputs) return sendJson(res, 200, []);
        return sendJson(res, 200, diffTrees(inputs.baseTree, inputs.headTree));
      }
      if (rest.length === 3 && rest[2] === "merge") {
        if (method !== "PUT") return sendError(res, 404, "Not Found");
        if (pr.state !== "open" || pr.merged) return sendError(res, 405, "Pull request is already closed");
        const inputs = prMergeInputs(repo, pr);
        if (!inputs) return sendError(res, 405, "Pull request cannot be merged");
        const merged = mergeTrees(inputs.baseTree, inputs.headTree, inputs.tipTree);
        if (merged.conflict) return sendError(res, 405, "Merge conflict");
        const baseTip = prBaseSha(repo, pr);
        const ts = tickSec();
        const commitSha = makeCommit(merged.tree, [baseTip], ts, pr.title);
        noteCommitSeq(commitSha);
        repo.branches.set(pr.baseRef, commitSha);
        pr.state = "closed";
        pr.merged = true;
        pr.mergeCommitSha = commitSha;
        pr.mergedAt = tickIso();
        pr.updatedAt = tickIso();
        repo.updatedAt = tickIso();
        return sendJson(res, 200, { sha: commitSha, merged: true, message: `Pull request #${num} merged` });
      }
      return sendError(res, 404, "Not Found");
    }
  }

  return sendError(res, 404, "Not Found");
}

// ------------------------------------------------------------ pkt-line codec

function pktLine(data: Buffer | string): Buffer {
  const d = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const head = Buffer.from((d.length + 4).toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, d]);
}
function pktFlush(): Buffer {
  return Buffer.from("0000", "ascii");
}
function pktDelim(): Buffer {
  return Buffer.from("0001", "ascii");
}

interface PktItem {
  kind: "data" | "flush" | "delim" | "end";
  data: Buffer;
}

// Parse a pkt-line stream; null when the bytes are not well-formed.
function parsePktLines(buf: Buffer): PktItem[] | null {
  const out: PktItem[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) return null;
    const hex = buf.subarray(off, off + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: "flush", data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: "delim", data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: "end", data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) return null;
    out.push({ kind: "data", data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// Frame a pack in side-band-64k: band 1 carries pack bytes, each pkt-line
// well under the 65,520-byte limit.
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const piece = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  return out;
}

function sidebandText(band: number, text: string): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), Buffer.from(text, "utf8")]));
}

// ------------------------------------------------------- git ref listings

interface RefLine {
  oid: string;
  name: string;
}

function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const branches = [...repo.branches.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, sha] of branches) out.push({ oid: sha, name: `refs/heads/${name}` });
  const tags = [...repo.tags.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, tag] of tags) {
    out.push({ oid: tag.sha, name: `refs/tags/${name}` });
    if (tag.type === "tag") {
      const full = objects.get(tag.sha);
      if (full) out.push({ oid: parseTag(full).object, name: `refs/tags/${name}^{}` });
    }
  }
  return out;
}

function advertisementV0(repo: Repo, service: "upload-pack" | "receive-pack"): Buffer {
  const caps =
    service === "upload-pack"
      ? "side-band-64k symref=HEAD:refs/heads/main object-format=sha1"
      : "report-status side-band-64k delete-refs symref=HEAD:refs/heads/main";
  const chunks: Buffer[] = [];
  chunks.push(pktLine(`# service=git-${service}\n`));
  chunks.push(pktFlush());
  const refs = refLines(repo);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      if (i === 0) chunks.push(pktLine(`${r.oid} ${r.name}\0${caps}\n`));
      else chunks.push(pktLine(`${r.oid} ${r.name}\n`));
    });
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine("version 2\n"),
    pktLine("agent=forge/1.0\n"),
    pktLine("ls-refs=unborn\n"),
    pktLine("fetch=shallow wait-for-done\n"),
    pktLine("server-option\n"),
    pktLine("object-format=sha1\n"),
    pktFlush(),
  ]);
}

// The ACK lines for a fetch: every held object that is an ancestor of a
// wanted one is acknowledged; otherwise the server answers NAK.
function ackLines(wants: string[], haves: string[]): string[] {
  const acks: string[] = [];
  for (const h of haves) {
    if (wants.some((w) => isAncestor(h, w))) acks.push(`ACK ${h}\n`);
  }
  if (acks.length === 0) return ["NAK\n"];
  return acks;
}

// ---------------------------------------------------------- git smart HTTP

async function handleGit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parts: string[],
  query: URLSearchParams,
  bodyBuf: Buffer,
): Promise<void> {
  const method = req.method ?? "GET";
  // parts: [owner, "<repo>.git", "info", "refs"] etc.
  if (parts.length < 3 || !parts[1].endsWith(".git")) return sendError(res, 404, "Not Found");
  const owner = parts[0];
  const repoName = parts[1].slice(0, -".git".length);
  const repo = getRepo(owner, repoName);
  const tail = parts.slice(2);

  // GET /{o}/{r}.git/info/refs?service=git-upload-pack|git-receive-pack
  if (method === "GET" && tail.length === 2 && tail[0] === "info" && tail[1] === "refs") {
    if (!repo) return sendError(res, 404, "Not Found");
    const service = query.get("service");
    if (service === "git-upload-pack") {
      const v2 = (req.headers["git-protocol"] ?? "") === "version=2";
      const ad = v2 ? advertisementV2() : advertisementV0(repo, "upload-pack");
      res.writeHead(200, {
        "content-type": "application/x-git-upload-pack-advertisement",
        "x-github-request-id": nextRequestId(),
        "content-length": String(ad.length),
      });
      return res.end(ad);
    }
    if (service === "git-receive-pack") {
      const ad = advertisementV0(repo, "receive-pack");
      res.writeHead(200, {
        "content-type": "application/x-git-receive-pack-advertisement",
        "x-github-request-id": nextRequestId(),
        "content-length": String(ad.length),
      });
      return res.end(ad);
    }
    return sendError(res, 404, "Not Found");
  }

  // POST /{o}/{r}.git/git-upload-pack
  if (method === "POST" && tail.length === 1 && tail[0] === "git-upload-pack") {
    if (!repo) return sendError(res, 404, "Not Found");
    const items = parsePktLines(bodyBuf);
    if (!items) {
      // Malformed input must not take the server down: answer empty and
      // stay healthy.
      res.writeHead(200, {
        "content-type": "application/x-git-upload-pack-result",
        "x-github-request-id": nextRequestId(),
        "content-length": "0",
      });
      return res.end();
    }
    const v2 = (req.headers["git-protocol"] ?? "") === "version=2";
    if (v2) return handleUploadPackV2(req, res, repo, items);
    return handleUploadPackV0(req, res, repo, items);
  }

  // POST /{o}/{r}.git/git-receive-pack
  if (method === "POST" && tail.length === 1 && tail[0] === "git-receive-pack") {
    if (!repo) return sendError(res, 404, "Not Found");
    return handleReceivePack(req, res, repo, bodyBuf);
  }

  return sendError(res, 404, "Not Found");
}

function handleUploadPackV0(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repo: Repo,
  items: PktItem[],
): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowHeld: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const it of items) {
    if (it.kind !== "data") continue;
    const line = it.data.toString("utf8").trim();
    if (line.startsWith("want ")) {
      const oid = line.slice(5).split(" ")[0];
      if (isHex40(oid)) wants.push(oid);
    } else if (line.startsWith("have ")) {
      const oid = line.slice(5).split(" ")[0];
      if (isHex40(oid)) haves.push(oid);
    } else if (line === "done") {
      done = true;
    } else if (line.startsWith("deepen ")) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line.startsWith("shallow ")) {
      const oid = line.slice(8).split(" ")[0];
      if (isHex40(oid)) shallowHeld.push(oid);
    }
  }
  void done;
  const chunks: Buffer[] = [];
  for (const a of ackLines(wants, haves)) chunks.push(pktLine(a));
  const held = new Set<string>([...haves, ...shallowHeld]);
  let pack: Buffer;
  if (depth !== null) {
    const plan = shallowPlan(wants, depth, held);
    for (const s of plan.boundary) chunks.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) chunks.push(pktLine(`unshallow ${u}\n`));
    pack = writePack([...plan.send]);
  } else {
    const haveReach = new Set<string>();
    for (const h of haves) for (const o of reachableFrom([h])) haveReach.add(o);
    const send = new Set<string>();
    for (const w of wants) for (const o of reachableFrom([w])) send.add(o);
    for (const h of haveReach) send.delete(h);
    pack = writePack([...send]);
  }
  for (const c of sidebandPack(pack)) chunks.push(c);
  chunks.push(pktFlush());
  const out = Buffer.concat(chunks);
  res.writeHead(200, {
    "content-type": "application/x-git-upload-pack-result",
    "x-github-request-id": nextRequestId(),
    "content-length": String(out.length),
  });
  res.end(out);
}

function handleUploadPackV2(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repo: Repo,
  items: PktItem[],
): void {
  // Request: command=<name>, optional agent/object-format, delim, args, flush.
  let command = "";
  const args: string[] = [];
  let sawDelim = false;
  for (const it of items) {
    if (it.kind === "data") {
      const line = it.data.toString("utf8").trim();
      if (!sawDelim && line.startsWith("command=")) command = line.slice("command=".length);
      else if (sawDelim) args.push(line);
    } else if (it.kind === "delim") {
      sawDelim = true;
    }
  }
  if (command === "ls-refs") return handleLsRefs(res, repo, args);
  if (command === "fetch") return handleFetchV2(res, repo, args);
  // Unknown command: answer an empty result rather than failing.
  const out = pktFlush();
  res.writeHead(200, {
    "content-type": "application/x-git-upload-pack-result",
    "x-github-request-id": nextRequestId(),
    "content-length": String(out.length),
  });
  res.end(out);
}

function handleLsRefs(res: http.ServerResponse, repo: Repo, args: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === "peel") peel = true;
    else if (a === "symrefs") symrefs = true;
    else if (a === "unborn") unborn = true;
    else if (a.startsWith("ref-prefix ")) prefixes.push(a.slice("ref-prefix ".length));
  }
  const chunks: Buffer[] = [];
  const defaultTip = branchTip(repo, repo.defaultBranch);
  const lines: Array<{ oid: string; name: string; attrs: string[] }> = [];
  if (symrefs) {
    const attrs = [`symref-target:refs/heads/${repo.defaultBranch}`];
    if (!defaultTip && unborn) attrs.push("unborn");
    lines.push({ oid: defaultTip ?? ZERO_OID, name: "HEAD", attrs });
  }
  for (const r of refLines(repo)) {
    const attrs: string[] = [];
    if (peel && r.name.endsWith("^{}")) {
      // Peeled lines are folded into the tag's own line below; skip here.
      continue;
    }
    if (peel && r.name.startsWith("refs/tags/")) {
      const tag = repo.tags.get(r.name.slice("refs/tags/".length));
      if (tag && tag.type === "tag") {
        const full = objects.get(tag.sha);
        if (full) attrs.push(`peeled:${parseTag(full).object}`);
      }
    }
    lines.push({ oid: r.oid, name: r.name, attrs });
  }
  for (const l of lines) {
    if (prefixes.length > 0 && !prefixes.some((p) => l.name.startsWith(p))) continue;
    const suffix = l.attrs.length > 0 ? ` ${l.attrs.join(" ")}` : "";
    chunks.push(pktLine(`${l.oid} ${l.name}${suffix}\n`));
  }
  chunks.push(pktFlush());
  const out = Buffer.concat(chunks);
  res.writeHead(200, {
    "content-type": "application/x-git-upload-pack-result",
    "x-github-request-id": nextRequestId(),
    "content-length": String(out.length),
  });
  res.end(out);
}

function handleFetchV2(res: http.ServerResponse, repo: Repo, args: string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const a of args) {
    if (a.startsWith("want ")) {
      const oid = a.slice(5).split(" ")[0];
      if (isHex40(oid)) wants.push(oid);
    } else if (a.startsWith("have ")) {
      const oid = a.slice(5).split(" ")[0];
      if (isHex40(oid)) haves.push(oid);
    } else if (a.startsWith("deepen ")) {
      const n = parseInt(a.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const chunks: Buffer[] = [];
  // acknowledgments
  chunks.push(pktLine("acknowledgments\n"));
  for (const a of ackLines(wants, haves)) chunks.push(pktLine(a));
  chunks.push(pktDelim());
  // shallow-info
  const held = new Set<string>(haves);
  let pack: Buffer;
  if (depth !== null) {
    const plan = shallowPlan(wants, depth, held);
    chunks.push(pktLine("shallow-info\n"));
    for (const s of plan.boundary) chunks.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) chunks.push(pktLine(`unshallow ${u}\n`));
    chunks.push(pktDelim());
    pack = writePack([...plan.send]);
  } else {
    const haveReach = new Set<string>();
    for (const h of haves) for (const o of reachableFrom([h])) haveReach.add(o);
    const send = new Set<string>();
    for (const w of wants) for (const o of reachableFrom([w])) send.add(o);
    for (const h of haveReach) send.delete(h);
    pack = writePack([...send]);
  }
  // wanted-refs
  chunks.push(pktLine("wanted-refs\n"));
  const refMap = new Map<string, string>();
  for (const r of refLines(repo)) {
    if (!r.name.endsWith("^{}")) refMap.set(r.oid, r.name);
  }
  for (const w of wants) {
    const ref = refMap.get(w);
    if (ref) chunks.push(pktLine(`${w} ${ref}\n`));
  }
  chunks.push(pktDelim());
  // packfile
  chunks.push(pktLine("packfile\n"));
  for (const c of sidebandPack(pack)) chunks.push(c);
  chunks.push(pktFlush());
  const out = Buffer.concat(chunks);
  res.writeHead(200, {
    "content-type": "application/x-git-upload-pack-result",
    "x-github-request-id": nextRequestId(),
    "content-length": String(out.length),
  });
  res.end(out);
}

function handleReceivePack(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  repo: Repo,
  bodyBuf: Buffer,
): void {
  // Ref update commands are pkt-lines up to a flush; the rest is the pack.
  const lines: Array<{ oldSha: string; newSha: string; ref: string }> = [];
  let packStart = bodyBuf.length;
  let off = 0;
  let malformed = false;
  while (off < bodyBuf.length) {
    if (off + 4 > bodyBuf.length) {
      malformed = true;
      break;
    }
    const hex = bodyBuf.subarray(off, off + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      malformed = true;
      break;
    }
    const len = parseInt(hex, 16);
    if (len === 0) {
      packStart = off + 4;
      break;
    }
    if (len < 4 || off + len > bodyBuf.length) {
      malformed = true;
      break;
    }
    const text = bodyBuf.subarray(off + 4, off + len).toString("utf8");
    const nul = text.indexOf("\0");
    const core = nul >= 0 ? text.slice(0, nul) : text;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(core.trim());
    if (!m) {
      malformed = true;
      break;
    }
    lines.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
    off += len;
  }
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  let unpackOk = !malformed;
  // A push that carries no pack (a delete-only push) is a valid empty pack.
  if (!malformed && lines.length > 0 && packStart < bodyBuf.length) {
    try {
      readPack(bodyBuf.subarray(packStart));
    } catch {
      unpackOk = false;
    }
  }
  if (unpackOk) {
    for (const { oldSha, newSha, ref } of lines) {
      if (ref.startsWith("refs/heads/")) {
        const branch = ref.slice("refs/heads/".length);
        if (newSha === ZERO_OID) {
          repo.branches.delete(branch);
          results.push({ ref, ok: true });
        } else if (oldSha === ZERO_OID) {
          if (!objects.has(newSha)) {
            results.push({ ref, ok: false, reason: "object not found" });
          } else {
            repo.branches.set(branch, newSha);
            noteCommitSeq(newSha);
            results.push({ ref, ok: true });
          }
        } else if (isAncestor(oldSha, newSha)) {
          repo.branches.set(branch, newSha);
          noteCommitSeq(newSha);
          results.push({ ref, ok: true });
        } else {
          results.push({ ref, ok: false, reason: "non-fast-forward" });
        }
      } else if (ref.startsWith("refs/tags/")) {
        const tag = ref.slice("refs/tags/".length);
        if (newSha === ZERO_OID) {
          repo.tags.delete(tag);
          results.push({ ref, ok: true });
        } else if (!objects.has(newSha)) {
          results.push({ ref, ok: false, reason: "object not found" });
        } else {
          repo.tags.set(tag, { sha: newSha, type: objType(newSha) ?? "commit" });
          results.push({ ref, ok: true });
        }
      } else {
        results.push({ ref, ok: false, reason: "invalid ref" });
      }
    }
    repo.updatedAt = tickIso();
  } else {
    for (const { ref } of lines) results.push({ ref, ok: false, reason: "unpack failed" });
  }
  const chunks: Buffer[] = [];
  chunks.push(sidebandText(1, unpackOk ? "unpack ok\n" : "unpack failed\n"));
  for (const r of results) {
    chunks.push(sidebandText(1, r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? "failed"}\n`));
  }
  chunks.push(pktFlush());
  const out = Buffer.concat(chunks);
  res.writeHead(200, {
    "content-type": "application/x-git-receive-pack-result",
    "x-github-request-id": nextRequestId(),
    "content-length": String(out.length),
  });
  res.end(out);
}

// ------------------------------------------------------------ GraphQL (subset)

// A small parser for the documents this service is asked to answer: one
// query or mutation per document, fields with aliases and arguments, inline
// fragments, variables, and literal/list/object argument values.

type GqlValue =
  | { kind: "string"; value: string }
  | { kind: "int"; value: number }
  | { kind: "float"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "var"; name: string }
  | { kind: "list"; items: GqlValue[] }
  | { kind: "object"; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selection: GqlField[] | null;
  fragmentType: string | null;
  isFragment: boolean;
}

interface GqlOperation {
  kind: "query" | "mutation";
  name: string | null;
  varDefs: Array<{ name: string; type: string }>;
  selection: GqlField[];
}

type Tok = { t: "punct" | "name" | "string" | "number"; v: string };

function tokenizeGql(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "{" || c === "}" || c === "(" || c === ")" || c === "[" || c === "]" || c === ":" || c === "!" || c === "$" || c === "=" || c === "@") {
      toks.push({ t: "punct", v: c });
      i++;
      continue;
    }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
      toks.push({ t: "punct", v: "..." });
      i += 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === "n") s += "\n";
          else if (e === "t") s += "\t";
          else if (e === "r") s += "\r";
          else if (e === '"') s += '"';
          else if (e === "\\") s += "\\";
          else if (e === "/") s += "/";
          else s += e;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      toks.push({ t: "string", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      if (src[j] === "-") j++;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "number", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  return toks;
}

class GqlParser {
  toks: Tok[];
  pos = 0;
  constructor(src: string) {
    this.toks = tokenizeGql(src);
  }
  peek(): Tok | null {
    return this.toks[this.pos] ?? null;
  }
  next(): Tok | null {
    return this.toks[this.pos++] ?? null;
  }
  expect(v: string): void {
    const t = this.next();
    if (!t || t.v !== v) throw new Error(`expected ${v}`);
  }
  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.peek()) ops.push(this.parseOperation());
    return ops;
  }
  parseOperation(): GqlOperation {
    let kind: "query" | "mutation" = "query";
    let name: string | null = null;
    const t = this.peek();
    if (t && t.t === "name" && (t.v === "query" || t.v === "mutation")) {
      kind = t.v as "query" | "mutation";
      this.next();
      const n = this.peek();
      if (n && n.t === "name") {
        name = n.v;
        this.next();
      }
    }
    const varDefs: Array<{ name: string; type: string }> = [];
    if (this.peek()?.v === "(") {
      this.next();
      while (this.peek() && this.peek()?.v !== ")") {
        if (this.peek()?.v === "$") {
          this.next();
          const vn = this.next();
          this.expect(":");
          let type = "";
          while (this.peek() && this.peek()?.v !== ")" && this.peek()?.v !== ",") {
            type += this.next()?.v ?? "";
          }
          varDefs.push({ name: vn?.v ?? "", type });
        } else {
          this.next();
        }
        if (this.peek()?.v === ",") this.next();
      }
      this.expect(")");
    }
    const selection = this.parseSelectionSet();
    return { kind, name, varDefs, selection };
  }
  parseSelectionSet(): GqlField[] {
    this.expect("{");
    const fields: GqlField[] = [];
    while (this.peek() && this.peek()?.v !== "}") fields.push(this.parseField());
    this.expect("}");
    return fields;
  }
  parseField(): GqlField {
    if (this.peek()?.v === "...") {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek()?.t === "name" && this.peek()?.v === "on") {
        this.next();
        fragmentType = this.next()?.v ?? null;
      }
      const sel = this.parseSelectionSet();
      return { alias: null, name: "", args: [], selection: sel, fragmentType, isFragment: true };
    }
    let alias: string | null = null;
    let name = "";
    const first = this.next();
    if (!first || first.t !== "name") throw new Error("expected field name");
    if (this.peek()?.v === ":") {
      this.next();
      alias = first.v;
      name = this.next()?.v ?? "";
    } else {
      name = first.v;
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek()?.v === "(") {
      this.next();
      while (this.peek() && this.peek()?.v !== ")") {
        const an = this.next();
        this.expect(":");
        args.push({ name: an?.v ?? "", value: this.parseValue() });
        if (this.peek()?.v === ",") this.next();
      }
      this.expect(")");
    }
    let selection: GqlField[] | null = null;
    if (this.peek()?.v === "{") selection = this.parseSelectionSet();
    return { alias, name, args, selection, fragmentType: null, isFragment: false };
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (!t) throw new Error("expected value");
    if (t.t === "string") return { kind: "string", value: t.v };
    if (t.t === "number") {
      return t.v.includes(".") ? { kind: "float", value: parseFloat(t.v) } : { kind: "int", value: parseInt(t.v, 10) };
    }
    if (t.v === "$") {
      const n = this.next();
      return { kind: "var", name: n?.v ?? "" };
    }
    if (t.v === "[") {
      const items: GqlValue[] = [];
      while (this.peek() && this.peek()?.v !== "]") {
        items.push(this.parseValue());
        if (this.peek()?.v === ",") this.next();
      }
      this.expect("]");
      return { kind: "list", items };
    }
    if (t.v === "{") {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() && this.peek()?.v !== "}") {
        const fn = this.next();
        this.expect(":");
        fields.push({ name: fn?.v ?? "", value: this.parseValue() });
        if (this.peek()?.v === ",") this.next();
      }
      this.expect("}");
      return { kind: "object", fields };
    }
    if (t.t === "name") {
      if (t.v === "true") return { kind: "bool", value: true };
      if (t.v === "false") return { kind: "bool", value: false };
      if (t.v === "null") return { kind: "null" };
      return { kind: "enum", value: t.v };
    }
    throw new Error(`unexpected token ${t.v}`);
  }
}

function resolveGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case "string":
    case "int":
    case "float":
    case "bool":
      return v.value;
    case "null":
      return null;
    case "enum":
      return v.value;
    case "var":
      return vars[v.name];
    case "list":
      return v.items.map((x) => resolveGqlValue(x, vars));
    case "object": {
      const o: Record<string, unknown> = {};
      for (const f of v.fields) o[f.name] = resolveGqlValue(f.value, vars);
      return o;
    }
  }
}

// What introspection says each type carries.
const GQL_TYPE_INFO: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Issue: { fields: ["id", "number", "title", "state", "body"] },
  PullRequest: { fields: ["id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files"] },
  Repository: {
    fields: [
      "id",
      "databaseId",
      "name",
      "nameWithOwner",
      "owner",
      "defaultBranchRef",
      "viewerPermission",
      "hasIssuesEnabled",
      "issue",
      "issues",
      "pullRequests",
      "pullRequest",
    ],
  },
  SearchType: { enumValues: ["ISSUE", "REPOSITORY", "USER"] },
};

const KNOWN_FIELDS: Record<string, string[]> = {
  Query: ["viewer", "repository", "node", "__type", "__schema"],
  Mutation: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
  User: ["login", "id", "name", "email"],
  Repository: [
    "id",
    "databaseId",
    "name",
    "nameWithOwner",
    "owner",
    "defaultBranchRef",
    "viewerPermission",
    "hasIssuesEnabled",
    "issue",
    "issues",
    "pullRequests",
    "pullRequest",
    "url",
    "description",
    "isPrivate",
    "createdAt",
    "updatedAt",
  ],
  Issue: ["id", "number", "title", "state", "body", "createdAt", "updatedAt", "url", "author"],
  PullRequest: [
    "id",
    "number",
    "title",
    "body",
    "state",
    "merged",
    "mergeable",
    "headRefName",
    "baseRefName",
    "files",
    "createdAt",
    "updatedAt",
    "url",
  ],
  IssueConnection: ["nodes", "pageInfo", "totalCount"],
  PullRequestConnection: ["nodes", "pageInfo", "totalCount"],
  FileConnection: ["nodes", "pageInfo", "totalCount"],
  FileChange: ["path", "filename", "status", "additions", "deletions", "changes"],
  PageInfo: ["hasNextPage", "endCursor", "hasPreviousPage", "startCursor"],
  Ref: ["name", "prefix"],
  Type: ["name", "kind", "fields", "enumValues", "description"],
  Field: ["name", "description"],
  EnumValue: ["name", "description"],
  CommentEdge: ["node", "cursor"],
  Comment: ["id", "body", "createdAt", "updatedAt"],
  CreateIssuePayload: ["issue", "clientMutationId"],
  CloseIssuePayload: ["issue", "clientMutationId"],
  CreatePullRequestPayload: ["pullRequest", "clientMutationId"],
  MergePullRequestPayload: ["pullRequest", "clientMutationId"],
  AddCommentPayload: ["commentEdge", "clientMutationId"],
};

function issueStateGql(state: "open" | "closed"): string {
  return state === "open" ? "OPEN" : "CLOSED";
}
function prStateGql(pr: PullItem): string {
  if (pr.merged) return "MERGED";
  return pr.state === "open" ? "OPEN" : "CLOSED";
}

function issueConnection(repo: Repo, args: Record<string, unknown>): {
  nodes: IssueItem[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
} {
  const states = args.states as string[] | undefined;
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const first = typeof args.first === "number" ? args.first : undefined;
  const after = typeof args.after === "string" ? args.after : undefined;
  let list = [...repo.issues.values()];
  if (states && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => want.has(i.state.toUpperCase()));
  }
  const dir = String(orderBy?.direction ?? "DESC").toUpperCase();
  list.sort((a, b) => {
    if (dir === "ASC") return a.createdSeq - b.createdSeq || a.number - b.number;
    return b.createdSeq - a.createdSeq || b.number - a.number;
  });
  let start = 0;
  if (after) {
    try {
      const m = /^cursor:(\d+)$/.exec(unb64(after));
      if (m) {
        const idx = list.findIndex((i) => i.number === parseInt(m[1], 10));
        if (idx >= 0) start = idx + 1;
      }
    } catch {
      // A cursor that does not decode starts from the beginning.
    }
  }
  const end = first !== undefined ? Math.min(start + first, list.length) : list.length;
  const page = list.slice(start, end);
  return {
    nodes: page,
    pageInfo: { hasNextPage: end < list.length, endCursor: page.length > 0 ? b64(`cursor:${page[page.length - 1].number}`) : null },
    totalCount: list.length,
  };
}

function prConnection(repo: Repo, args: Record<string, unknown>): {
  nodes: PullItem[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
} {
  const first = typeof args.first === "number" ? args.first : undefined;
  const list = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  const end = first !== undefined ? Math.min(first, list.length) : list.length;
  const page = list.slice(0, end);
  return {
    nodes: page,
    pageInfo: { hasNextPage: end < list.length, endCursor: page.length > 0 ? b64(`cursor:${page[page.length - 1].number}`) : null },
    totalCount: list.length,
  };
}

// Decode a global id: "repo:owner/name", "issue:owner/repo/n", "pr:owner/repo/n",
// "comment:owner/repo/issue/n". Returns the kind and the parts.
function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const s = unb64(id);
    const colon = s.indexOf(":");
    if (colon < 0) return null;
    return { kind: s.slice(0, colon), parts: s.slice(colon + 1).split("/") };
  } catch {
    return null;
  }
}

function repoFromGlobalId(id: string): Repo | null {
  const d = decodeGlobalId(id);
  if (!d || d.kind !== "repo" || d.parts.length < 2) return null;
  return getRepo(d.parts[0], d.parts.slice(1).join("/")) ?? null;
}
function issueFromGlobalId(id: string): { repo: Repo; issue: IssueItem } | null {
  const d = decodeGlobalId(id);
  if (!d || d.kind !== "issue" || d.parts.length < 3) return null;
  const repo = getRepo(d.parts[0], d.parts[1]);
  if (!repo) return null;
  const issue = repo.issues.get(parseInt(d.parts[2], 10));
  if (!issue) return null;
  return { repo, issue };
}
function prFromGlobalId(id: string): { repo: Repo; pr: PullItem } | null {
  const d = decodeGlobalId(id);
  if (!d || d.kind !== "pr" || d.parts.length < 3) return null;
  const repo = getRepo(d.parts[0], d.parts[1]);
  if (!repo) return null;
  const pr = repo.pulls.get(parseInt(d.parts[2], 10));
  if (!pr) return null;
  return { repo, pr };
}

// Resolve one field: returns the value, the GraphQL type its selection set
// (if any) resolves against, and the repository that value belongs to (so a
// nested selection can still reach the store). ctxRepo is the repository of
// the object whose field this is; for a Repository it is the value itself.
function resolveFieldValue(
  typeName: string,
  value: Record<string, unknown> | null,
  field: GqlField,
  vars: Record<string, unknown>,
  errors: Array<{ message: string }>,
  ctxRepo: Repo | null,
): { v: unknown; t: string | null; repo?: Repo | null } {
  const args: Record<string, unknown> = {};
  for (const a of field.args) args[a.name] = resolveGqlValue(a.value, vars);
  const repo = typeName === "Repository" ? ((value as unknown as Repo | null) ?? null) : ctxRepo;

  if (typeName === "Query") {
    if (field.name === "viewer") return { v: { login: viewerLogin }, t: "User" };
    if (field.name === "repository") {
      const owner = String(args.owner ?? "");
      const name = String(args.name ?? "");
      const r = owner === viewerLogin ? getRepo(owner, name) ?? null : null;
      return { v: r, t: "Repository", repo: r };
    }
    if (field.name === "node") {
      const d = decodeGlobalId(String(args.id ?? ""));
      if (!d) return { v: null, t: null };
      if (d.kind === "repo" && d.parts.length >= 2) {
        const r = getRepo(d.parts[0], d.parts.slice(1).join("/"));
        return { v: r ?? null, t: "Repository", repo: r ?? null };
      }
      return { v: null, t: null };
    }
    if (field.name === "__type") {
      const info = GQL_TYPE_INFO[String(args.name ?? "")];
      if (!info) return { v: null, t: "Type" };
      return {
        v: {
          name: String(args.name),
          fields: (info.fields ?? []).map((n) => ({ name: n })),
          enumValues: (info.enumValues ?? []).map((n) => ({ name: n })),
        },
        t: "Type",
      };
    }
    if (field.name === "__schema") {
      return { v: { types: Object.keys(GQL_TYPE_INFO).map((n) => ({ name: n })) }, t: "Schema" };
    }
  }

  if (typeName === "Mutation") {
    if (field.name === "createIssue") {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const r = repoFromGlobalId(String(input.repositoryId ?? ""));
      if (!r) {
        errors.push({ message: "repository not found" });
        return { v: { issue: null }, t: "CreateIssuePayload" };
      }
      const number = r.nextIssue++;
      const now = tickIso();
      const issue: IssueItem = {
        id: nextGlobalIssueId++,
        nodeId: b64(`issue:${r.owner}/${r.name}/${number}`),
        number,
        title: String(input.title ?? ""),
        body: String(input.body ?? ""),
        state: "open",
        labels: [],
        createdSeq: nextSeq(),
        createdAt: now,
        updatedAt: now,
        comments: [],
      };
      r.issues.set(number, issue);
      return { v: { issue }, t: "CreateIssuePayload", repo: r };
    }
    if (field.name === "closeIssue") {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(String(input.issueId ?? ""));
      if (!found) {
        errors.push({ message: "issue not found" });
        return { v: { issue: null }, t: "CloseIssuePayload" };
      }
      found.issue.state = "closed";
      found.issue.updatedAt = tickIso();
      return { v: { issue: found.issue }, t: "CloseIssuePayload", repo: found.repo };
    }
    if (field.name === "createPullRequest") {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const r = repoFromGlobalId(String(input.repositoryId ?? ""));
      if (!r) {
        errors.push({ message: "repository not found" });
        return { v: { pullRequest: null }, t: "CreatePullRequestPayload" };
      }
      const head = String(input.headRefName ?? "");
      const base = String(input.baseRefName ?? "");
      const headSha = branchTip(r, head);
      const baseSha = branchTip(r, base);
      if (!headSha || !baseSha) {
        errors.push({ message: "head or base branch does not exist" });
        return { v: { pullRequest: null }, t: "CreatePullRequestPayload" };
      }
      const number = r.nextPull++;
      const now = tickIso();
      const pr: PullItem = {
        id: nextGlobalPrId++,
        nodeId: b64(`pr:${r.owner}/${r.name}/${number}`),
        number,
        title: String(input.title ?? ""),
        body: String(input.body ?? ""),
        state: "open",
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        createdSeq: nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      r.pulls.set(number, pr);
      return { v: { pullRequest: pr }, t: "CreatePullRequestPayload", repo: r };
    }
    if (field.name === "mergePullRequest") {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = prFromGlobalId(String(input.pullRequestId ?? ""));
      if (!found) {
        errors.push({ message: "pull request not found" });
        return { v: { pullRequest: null }, t: "MergePullRequestPayload" };
      }
      const { repo: r, pr } = found;
      if (pr.state === "open" && !pr.merged) {
        const inputs = prMergeInputs(r, pr);
        if (inputs) {
          const merged = mergeTrees(inputs.baseTree, inputs.headTree, inputs.tipTree);
          if (!merged.conflict) {
            const baseTip = prBaseSha(r, pr);
            const commitSha = makeCommit(merged.tree, [baseTip], tickSec(), pr.title);
            noteCommitSeq(commitSha);
            r.branches.set(pr.baseRef, commitSha);
            pr.state = "closed";
            pr.merged = true;
            pr.mergeCommitSha = commitSha;
            pr.mergedAt = tickIso();
            pr.updatedAt = tickIso();
          }
        }
      }
      return { v: { pullRequest: pr }, t: "MergePullRequestPayload", repo: r };
    }
    if (field.name === "addComment") {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(String(input.subjectId ?? ""));
      if (!found) {
        errors.push({ message: "issue not found" });
        return { v: { commentEdge: null }, t: "AddCommentPayload" };
      }
      const now = tickIso();
      const id = found.repo.nextCommentId++;
      const comment: CommentItem = {
        id,
        nodeId: b64(`comment:${found.repo.owner}/${found.repo.name}/${found.issue.number}/${id}`),
        body: String(input.body ?? ""),
        createdAt: now,
        updatedAt: now,
      };
      found.issue.comments.push(comment);
      found.issue.updatedAt = tickIso();
      return { v: { commentEdge: { node: comment, cursor: b64(`cursor:${id}`) } }, t: "AddCommentPayload", repo: found.repo };
    }
  }

  if (typeName === "User") {
    const u = value as unknown as { login?: string };
    if (field.name === "login") return { v: u?.login ?? viewerLogin, t: null };
    if (field.name === "id") return { v: b64(`user:${u?.login ?? viewerLogin}`), t: null };
    if (field.name === "name") return { v: u?.login ?? viewerLogin, t: null };
    if (field.name === "email") return { v: `${u?.login ?? viewerLogin}@example.invalid`, t: null };
  }

  if (typeName === "Repository" && repo) {
    if (field.name === "id") return { v: repo.nodeId, t: null };
    if (field.name === "databaseId") return { v: repo.id, t: null };
    if (field.name === "name") return { v: repo.name, t: null };
    if (field.name === "nameWithOwner") return { v: `${repo.owner}/${repo.name}`, t: null };
    if (field.name === "owner") return { v: { login: repo.owner }, t: "User" };
    if (field.name === "defaultBranchRef") return { v: { name: repo.defaultBranch }, t: "Ref" };
    if (field.name === "viewerPermission") return { v: "ADMIN", t: null };
    if (field.name === "hasIssuesEnabled") return { v: true, t: null };
    if (field.name === "url") return { v: `https://github.com/${repo.owner}/${repo.name}`, t: null };
    if (field.name === "description") return { v: repo.description, t: null };
    if (field.name === "isPrivate") return { v: repo.isPrivate, t: null };
    if (field.name === "createdAt") return { v: repo.createdAt, t: null };
    if (field.name === "updatedAt") return { v: repo.updatedAt, t: null };
    if (field.name === "issue") {
      const issue = repo.issues.get(Number(args.number));
      return { v: issue ?? null, t: "Issue", repo };
    }
    if (field.name === "issues") return { v: issueConnection(repo, args), t: "IssueConnection", repo };
    if (field.name === "pullRequests") return { v: prConnection(repo, args), t: "PullRequestConnection", repo };
    if (field.name === "pullRequest") {
      const pr = repo.pulls.get(Number(args.number));
      return { v: pr ?? null, t: "PullRequest", repo };
    }
  }

  if (typeName === "Issue") {
    const issue = value as unknown as IssueItem;
    if (field.name === "id") return { v: issue.nodeId, t: null };
    if (field.name === "number") return { v: issue.number, t: null };
    if (field.name === "title") return { v: issue.title, t: null };
    if (field.name === "state") return { v: issueStateGql(issue.state), t: null };
    if (field.name === "body") return { v: issue.body, t: null };
    if (field.name === "createdAt") return { v: issue.createdAt, t: null };
    if (field.name === "updatedAt") return { v: issue.updatedAt, t: null };
    if (field.name === "url") return { v: `https://github.com/${repo?.owner ?? viewerLogin}/${repo?.name ?? ""}/issues/${issue.number}`, t: null };
    if (field.name === "author") return { v: { login: repo?.owner ?? viewerLogin }, t: "User" };
  }

  if (typeName === "PullRequest") {
    const pr = value as unknown as PullItem;
    if (field.name === "id") return { v: pr.nodeId, t: null };
    if (field.name === "number") return { v: pr.number, t: null };
    if (field.name === "title") return { v: pr.title, t: null };
    if (field.name === "body") return { v: pr.body, t: null };
    if (field.name === "state") return { v: prStateGql(pr), t: null };
    if (field.name === "merged") return { v: pr.merged, t: null };
    if (field.name === "headRefName") return { v: pr.headRef, t: null };
    if (field.name === "baseRefName") return { v: pr.baseRef, t: null };
    if (field.name === "mergeable") {
      if (pr.state !== "open" || !repo) return { v: "UNKNOWN", t: null };
      return { v: prHasConflict(repo, pr) ? "CONFLICTING" : "MERGEABLE", t: null };
    }
    if (field.name === "files") {
      if (!repo) return { v: { nodes: [] }, t: "FileConnection", repo: ctxRepo };
      const inputs = prMergeInputs(repo, pr);
      const changes = inputs ? diffTrees(inputs.baseTree, inputs.headTree) : [];
      const first = typeof args.first === "number" ? args.first : changes.length;
      const nodes = changes.slice(0, first).map((c) => ({
        path: c.filename,
        filename: c.filename,
        status: c.status,
        additions: c.additions,
        deletions: c.deletions,
        changes: c.changes,
      }));
      return { v: { nodes, pageInfo: { hasNextPage: changes.length > first, endCursor: null }, totalCount: changes.length }, t: "FileConnection", repo: ctxRepo };
    }
    if (field.name === "createdAt") return { v: pr.createdAt, t: null };
    if (field.name === "updatedAt") return { v: pr.updatedAt, t: null };
    if (field.name === "url") return { v: `https://github.com/${repo?.owner ?? viewerLogin}/${repo?.name ?? ""}/pull/${pr.number}`, t: null };
  }

  if (typeName === "IssueConnection" || typeName === "PullRequestConnection" || typeName === "FileConnection") {
    const conn = value as unknown as { nodes: unknown[]; pageInfo: unknown; totalCount: number };
    if (field.name === "nodes") {
      const t =
        typeName === "IssueConnection" ? "Issue" : typeName === "PullRequestConnection" ? "PullRequest" : "FileChange";
      return { v: conn.nodes, t, repo: ctxRepo };
    }
    if (field.name === "pageInfo") return { v: conn.pageInfo, t: "PageInfo" };
    if (field.name === "totalCount") return { v: conn.totalCount, t: null };
  }

  if (typeName === "FileChange") {
    const f = value as unknown as FileChange;
    if (field.name === "path") return { v: f.path, t: null };
    if (field.name === "filename") return { v: f.filename, t: null };
    if (field.name === "status") return { v: f.status, t: null };
    if (field.name === "additions") return { v: f.additions, t: null };
    if (field.name === "deletions") return { v: f.deletions, t: null };
    if (field.name === "changes") return { v: f.changes, t: null };
  }

  if (typeName === "PageInfo") {
    const p = value as unknown as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === "hasNextPage") return { v: p.hasNextPage, t: null };
    if (field.name === "endCursor") return { v: p.endCursor, t: null };
    if (field.name === "hasPreviousPage") return { v: false, t: null };
    if (field.name === "startCursor") return { v: null, t: null };
  }

  if (typeName === "Ref") {
    const r = value as unknown as { name: string };
    if (field.name === "name") return { v: r.name, t: null };
    if (field.name === "prefix") return { v: "refs/heads/", t: null };
  }

  if (typeName === "Type") {
    const t = value as unknown as { name: string; fields: Array<{ name: string }>; enumValues: Array<{ name: string }> };
    if (field.name === "name") return { v: t.name, t: null };
    if (field.name === "kind") return { v: t.enumValues ? "ENUM" : "OBJECT", t: null };
    if (field.name === "fields") return { v: t.fields ?? [], t: "Field" };
    if (field.name === "enumValues") return { v: t.enumValues ?? [], t: "EnumValue" };
    if (field.name === "description") return { v: null, t: null };
  }

  if (typeName === "Field" || typeName === "EnumValue") {
    const f = value as unknown as { name: string };
    if (field.name === "name") return { v: f.name, t: null };
    if (field.name === "description") return { v: null, t: null };
  }

  if (typeName === "CommentEdge") {
    const e = value as unknown as { node: CommentItem; cursor: string };
    if (field.name === "node") return { v: e.node, t: "Comment", repo: ctxRepo };
    if (field.name === "cursor") return { v: e.cursor, t: null };
  }

  if (typeName === "Comment") {
    const c = value as unknown as CommentItem;
    if (field.name === "id") return { v: c.nodeId, t: null };
    if (field.name === "body") return { v: c.body, t: null };
    if (field.name === "createdAt") return { v: c.createdAt, t: null };
    if (field.name === "updatedAt") return { v: c.updatedAt, t: null };
  }

  if (
    typeName === "CreateIssuePayload" ||
    typeName === "CloseIssuePayload" ||
    typeName === "CreatePullRequestPayload" ||
    typeName === "MergePullRequestPayload" ||
    typeName === "AddCommentPayload"
  ) {
    const p = value as unknown as Record<string, unknown>;
    if (field.name === "issue") return { v: (p.issue as IssueItem | null) ?? null, t: "Issue", repo: ctxRepo };
    if (field.name === "pullRequest") return { v: (p.pullRequest as PullItem | null) ?? null, t: "PullRequest", repo: ctxRepo };
    if (field.name === "commentEdge") return { v: (p.commentEdge as unknown) ?? null, t: "CommentEdge", repo: ctxRepo };
    if (field.name === "clientMutationId") return { v: null, t: null };
  }

  if (typeName === "Schema") {
    return { v: null, t: null };
  }

  return { v: null, t: null };
}

function resolveSel(
  typeName: string,
  value: unknown,
  fields: GqlField[],
  vars: Record<string, unknown>,
  errors: Array<{ message: string }>,
  ctxRepo: Repo | null = null,
): unknown {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.isFragment) {
      if (f.fragmentType && f.fragmentType !== typeName) continue;
      const sub = resolveSel(typeName, value, f.selection ?? [], vars, errors, ctxRepo);
      if (sub && typeof sub === "object") Object.assign(out, sub as Record<string, unknown>);
      continue;
    }
    const key = f.alias ?? f.name;
    const known = KNOWN_FIELDS[typeName] ?? [];
    if (!known.includes(f.name)) {
      errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const { v, t, repo: nextRepo } = resolveFieldValue(
      typeName,
      value as Record<string, unknown> | null,
      f,
      vars,
      errors,
      ctxRepo,
    );
    const childRepo = nextRepo ?? ctxRepo;
    if (f.selection && v !== null && v !== undefined) {
      if (Array.isArray(v)) {
        out[key] = v.map((el) => resolveSel(t ?? "Unknown", el, f.selection ?? [], vars, errors, childRepo));
      } else {
        out[key] = resolveSel(t ?? "Unknown", v, f.selection ?? [], vars, errors, childRepo);
      }
    } else {
      out[key] = v;
    }
  }
  return out;
}

function execGql(item: unknown): Record<string, unknown> {
  const o = (item ?? {}) as { query?: string; variables?: Record<string, unknown> };
  const query = typeof o.query === "string" ? o.query : "";
  const vars = (o.variables ?? {}) as Record<string, unknown>;
  try {
    const parser = new GqlParser(query);
    const ops = parser.parseDocument();
    if (ops.length === 0) return { data: null, errors: [{ message: "No operation provided" }] };
    const op = ops[0];
    const errors: Array<{ message: string }> = [];
    const rootType = op.kind === "mutation" ? "Mutation" : "Query";
    const data = resolveSel(rootType, {}, op.selection, vars, errors);
    return errors.length > 0 ? { data, errors } : { data };
  } catch (e) {
    return { data: null, errors: [{ message: String((e as Error).message ?? e) }] };
  }
}

function handleGraphql(res: http.ServerResponse, body: unknown): void {
  if (Array.isArray(body)) {
    return sendJson(res, 200, body.map((item) => execGql(item)));
  }
  return sendJson(res, 200, execGql(body));
}

// --------------------------------------------------------------------- MCP

// The tool list is a fixed literal, so two tools/list calls answer the same
// list byte for byte. `required` lists only what the caller always provides;
// owner/repo may also arrive as full_name ("owner/repo").
const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: "create_repo",
    description: "Create a repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repository is private" },
        owner: { type: "string", description: "Owner login (defaults to the authenticated user)" },
        full_name: { type: "string", description: "Repository full name, owner/repo" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        full_name: { type: "string", description: "Repository full name, owner/repo" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body" },
        full_name: { type: "string", description: "Repository full name, owner/repo" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", description: "open, closed or all" },
        full_name: { type: "string", description: "Repository full name, owner/repo" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Open a pull request from a head branch onto a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        title: { type: "string", description: "Pull request title" },
        head: { type: "string", description: "Head branch name" },
        base: { type: "string", description: "Base branch name" },
        body: { type: "string", description: "Pull request body" },
        full_name: { type: "string", description: "Repository full name, owner/repo" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request with a squash merge.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner login" },
        repo: { type: "string", description: "Repository name" },
        pull_number: { type: "integer", description: "Pull request number" },
        full_name: { type: "string", description: "Repository full name, owner/repo" },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  if (typeof args.full_name === "string" && args.full_name.includes("/")) {
    const [o, ...rest] = args.full_name.split("/");
    return { owner: o, repo: rest.join("/") };
  }
  return { owner: String(args.owner ?? viewerLogin), repo: String(args.repo ?? "") };
}

function mcpToolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: "text", text }], structuredContent: obj };
}

function mcpToolError(msg: string): Record<string, unknown> {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>, host: string): Record<string, unknown> {
  if (name === "create_repo") {
    const repoName = String(args.name ?? "");
    if (!repoName) return mcpToolError("missing required argument: name");
    const { owner } = mcpOwnerRepo(args);
    const o = owner || viewerLogin;
    if (o !== viewerLogin) return mcpToolError(`cannot create a repository for ${o}`);
    if (getRepo(o, repoName)) return mcpToolError(`repository already exists: ${o}/${repoName}`);
    const repo = createRepoRecord(o, repoName, String(args.description ?? ""), args.private === true);
    return mcpToolResult(repoJson(repo, host));
  }
  if (name === "get_repo") {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    if (!repoName) return mcpToolError("missing required argument: repo");
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository not found: ${owner}/${repoName}`);
    return mcpToolResult(repoJson(repo, host));
  }
  if (name === "create_issue") {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const title = String(args.title ?? "");
    if (!repoName) return mcpToolError("missing required argument: repo");
    if (!title) return mcpToolError("missing required argument: title");
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository not found: ${owner}/${repoName}`);
    const number = repo.nextIssue++;
    const now = tickIso();
    const issue: IssueItem = {
      id: nextGlobalIssueId++,
      nodeId: b64(`issue:${owner}/${repoName}/${number}`),
      number,
      title,
      body: String(args.body ?? ""),
      state: "open",
      labels: [],
      createdSeq: nextSeq(),
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.issues.set(number, issue);
    return mcpToolResult(issueJson(repo, issue, host));
  }
  if (name === "list_issues") {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    if (!repoName) return mcpToolError("missing required argument: repo");
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository not found: ${owner}/${repoName}`);
    const state = String(args.state ?? "open");
    let list = [...repo.issues.values()];
    if (state === "open") list = list.filter((i) => i.state === "open");
    else if (state === "closed") list = list.filter((i) => i.state === "closed");
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return mcpToolResult({ issues: list.map((i) => issueJson(repo, i, host)) });
  }
  if (name === "create_pull_request") {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const title = String(args.title ?? "");
    const head = String(args.head ?? "");
    const base = String(args.base ?? "");
    if (!repoName) return mcpToolError("missing required argument: repo");
    if (!title) return mcpToolError("missing required argument: title");
    if (!head) return mcpToolError("missing required argument: head");
    if (!base) return mcpToolError("missing required argument: base");
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository not found: ${owner}/${repoName}`);
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (!headSha || !baseSha) return mcpToolError("head or base branch does not exist");
    const number = repo.nextPull++;
    const now = tickIso();
    const pr: PullItem = {
      id: nextGlobalPrId++,
      nodeId: b64(`pr:${owner}/${repoName}/${number}`),
      number,
      title,
      body: String(args.body ?? ""),
      state: "open",
      merged: false,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedAt: null,
      createdSeq: nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(number, pr);
    return mcpToolResult(pullJson(repo, pr, host));
  }
  if (name === "merge_pull_request") {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    const pullNumber = Number(args.pull_number);
    if (!repoName) return mcpToolError("missing required argument: repo");
    if (!Number.isInteger(pullNumber)) return mcpToolError("missing required argument: pull_number");
    const repo = getRepo(owner, repoName);
    if (!repo) return mcpToolError(`repository not found: ${owner}/${repoName}`);
    const pr = repo.pulls.get(pullNumber);
    if (!pr) return mcpToolError(`pull request not found: ${pullNumber}`);
    if (pr.state !== "open" || pr.merged) return mcpToolError("pull request is already closed");
    const inputs = prMergeInputs(repo, pr);
    if (!inputs) return mcpToolError("pull request cannot be merged");
    const merged = mergeTrees(inputs.baseTree, inputs.headTree, inputs.tipTree);
    if (merged.conflict) return mcpToolError("merge conflict");
    const baseTip = prBaseSha(repo, pr);
    const commitSha = makeCommit(merged.tree, [baseTip], tickSec(), pr.title);
    noteCommitSeq(commitSha);
    repo.branches.set(pr.baseRef, commitSha);
    pr.state = "closed";
    pr.merged = true;
    pr.mergeCommitSha = commitSha;
    pr.mergedAt = tickIso();
    pr.updatedAt = tickIso();
    return mcpToolResult({ merged: true, sha: commitSha, number: pr.number, state: "closed" });
  }
  return mcpToolError(`unknown tool: ${name}`);
}

function findMcpTool(name: string): string | null {
  const lower = name.toLowerCase();
  for (const t of MCP_TOOLS) {
    if (lower === t.name || lower.endsWith(t.name)) return t.name;
  }
  return null;
}

function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, bodyBuf: Buffer): void {
  const host = req.headers.host ?? "127.0.0.1";
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const id = (body?.id as unknown) ?? null;
  const method = String(body?.method ?? "");
  const params = (body?.params ?? {}) as Record<string, unknown>;
  if (method.startsWith("notifications/")) {
    res.writeHead(202, { "x-github-request-id": nextRequestId() });
    return res.end();
  }
  if (method === "server/discover") {
    // The 2026-07-28 discover answer carries the supported revisions, the
    // capabilities and the server's identity in one result.
    const identity = { name: "forge", version: VERSION };
    return sendJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
        capabilities: { tools: {} },
        serverInfo: identity,
        _meta: { "io.modelcontextprotocol/serverInfo": identity },
      },
    });
  }
  if (method === "initialize") {
    const pv = typeof params.protocolVersion === "string" ? params.protocolVersion : "2026-07-28";
    return sendJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: pv,
        capabilities: { tools: {} },
        serverInfo: { name: "forge", version: VERSION },
      },
    });
  }
  if (method === "ping") {
    return sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
  }
  if (method === "tools/list") {
    return sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = findMcpTool(name);
    if (!tool) {
      return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    }
    const result = callMcpTool(tool, args, host);
    return sendJson(res, 200, { jsonrpc: "2.0", id, result });
  }
  return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ------------------------------------------------------------- router + main

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const host = req.headers.host ?? "127.0.0.1";
  const pathname = url.pathname;
  const query = url.searchParams;
  const parts = pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  if (pathname === "/healthz" && req.method === "GET") {
    return sendJson(res, 200, { ok: true });
  }

  // Drain the body first so the connection stays usable, then authenticate.
  const bodyBuf = await readBody(req);
  if (!requireAuth(req, res)) return;

  if (parts.length >= 2 && parts[0] === "api" && parts[1] === "v3") {
    const parsed = parseJson(bodyBuf);
    if (!parsed.ok) return sendError(res, 400, "Invalid JSON");
    return handleRest(req, res, parts.slice(2), query, parsed.value, host);
  }
  if (parts.length >= 2 && parts[0] === "api" && parts[1] === "graphql") {
    const parsed = parseJson(bodyBuf);
    if (!parsed.ok) return sendError(res, 400, "Invalid JSON");
    return handleGraphql(res, parsed.value);
  }
  if (parts.length >= 1 && parts[0] === "mcp") {
    return handleMcp(req, res, bodyBuf);
  }
  if (parts.length >= 2 && parts[1].endsWith(".git")) {
    return handleGit(req, res, parts, query, bodyBuf);
  }
  return sendError(res, 404, "Not Found");
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error("handler error:", e);
    try {
      if (!res.headersSent) sendError(res, 500, "Internal error");
      else res.end();
    } catch {
      // The response is already gone; nothing more to do.
    }
  });
});

async function main(): Promise<void> {
  if (!ENV_URL) {
    console.error("MAKEFUN_ENV_URL is not set");
    process.exit(1);
  }
  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  console.log(`forge listening on 0.0.0.0:${port}`);

  try {
    const r = await fetch(`${ENV_URL}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    });
    if (r.ok) {
      try {
        const j = (await r.json()) as Record<string, unknown>;
        const login = (j as { login?: unknown }).login ?? (j as { viewer?: { login?: unknown } }).viewer?.login;
        if (typeof login === "string" && login.length > 0) viewerLogin = login;
      } catch {
        // The register answer carries no login; the token names the viewer.
      }
    } else {
      console.error(`register failed: HTTP ${r.status}`);
    }
  } catch (e) {
    console.error("register error:", e);
  }

  // Poll until the environment says the trial is over, then exit 0.
  let delay = 250;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2000);
    try {
      const r = await fetch(`${ENV_URL}/done`);
      if (r.ok) {
        const j = (await r.json()) as { done?: boolean };
        if (j.done === true) break;
      }
    } catch {
      // The environment is not answering yet; keep polling.
    }
  }
  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
