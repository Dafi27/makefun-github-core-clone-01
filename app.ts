// app.ts — the forge's HTTP server: the REST API under /api/v3, GraphQL at /api/graphql,
// MCP at /mcp, and the git smart-HTTP endpoints under /<owner>/<repo>.git.
//
// Auth: every endpoint except GET /healthz requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.
// When the token is unset (local development) any non-empty Bearer token is accepted; a missing
// or empty token is always a 401. Every REST reply is application/json with a non-empty
// X-GitHub-Request-Id, errors are JSON {"message": string}, an unknown route is a JSON 404, and
// a malformed JSON body is a 400.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  PktLineDecoder,
  readPack,
  writePack,
  ZERO_OID,
} from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { VIEWER_LOGIN, VIEWER_USER } from './scenario.ts';
import { EMPTY_TREE_OID, REST_AUTHOR, REST_TIMESTAMP, Store, seqTimestamp, type Issue, type Pull, type Repo } from './store.ts';

export const AGENT_NAME = 'makefun-git-forge/1.0';

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

let requestCounter = 0;

/** Deterministic request ids (one counter per process; never in the state export). */
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function expectedToken(): string | undefined {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token === '' ? undefined : token;
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  const expected = expectedToken();
  if (expected === undefined) return true;
  return token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        req.destroy();
        reject(new Error('request body exceeds 64 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(bytes);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function errorJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Split a pathname into decoded segments (a bad escape is a 400, not a crash). */
function pathSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of parts) {
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return out;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Slice a list into a page and build the Link header GitHub clients follow. */
function paginate<T>(
  req: IncomingMessage,
  url: URL,
  items: readonly T[],
): { page: T[]; link: string | null } {
  const rawPerPage = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(Math.max(rawPerPage, 1), 100) : 30;
  const rawPage = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) ? Math.max(rawPage, 1) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const links: string[] = [];
  const base = `${originOf(req)}${url.pathname}`;
  const linkFor = (p: number, rel: string): string =>
    `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  if (totalPages > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(totalPages, 'last'));
  }
  return { page: items.slice(start, start + perPage), link: links.length ? links.join(', ') : null };
}

// ---------------------------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_USER.id, type: 'User' },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: seqTimestamp(repo.createdSeq),
    updated_at: seqTimestamp(repo.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    git_url: `${origin}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  return { name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' };
}

function issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER_LOGIN, id: VIEWER_USER.id, type: 'User' },
    created_at: seqTimestamp(issue.seq),
    updated_at: seqTimestamp(issue.seq),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; seq: number }, origin: string): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_USER.id, type: 'User' },
    created_at: seqTimestamp(comment.seq),
    updated_at: seqTimestamp(comment.seq),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  const mergeable = pull.state === 'open' ? pullMergeable(store, repo, pull) === 'MERGEABLE' : false;
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'merged' ? 'closed' : pull.state,
    merged: pull.merged,
    mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: { ref: pull.headRef, sha: pull.headSha, repo: { full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner } } },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: { full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner } } },
    user: { login: VIEWER_LOGIN, id: VIEWER_USER.id, type: 'User' },
    created_at: seqTimestamp(pull.seq),
    updated_at: seqTimestamp(pull.seq),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function pullMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = store.branchTip(repo, pull.baseRef);
  const headTip = store.peelToCommit(pull.headSha);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const baseTree = parseCommit(store.getObject(baseTip)!.data).tree;
  const headTree = parseCommit(store.getObject(headTip)!.data).tree;
  const mergeBaseOid = store.mergeBase(baseTip, headTip);
  if (mergeBaseOid === null) return 'UNKNOWN';
  const mergeBaseTree = parseCommit(store.getObject(mergeBaseOid)!.data).tree;
  return store.hasMergeConflict(baseTree, headTree, mergeBaseTree) ? 'CONFLICTING' : 'MERGEABLE';
}

function commitJson(store: Store, sha: string, origin: string, repo: Repo): Record<string, unknown> | null {
  const object = store.getObject(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const message = commit.message;
  const authorLine = commit.author || REST_AUTHOR;
  const committerLine = commit.committer || REST_AUTHOR;
  const authorName = authorLine.split(' <')[0];
  const authorEmail = (authorLine.match(/<([^>]*)>/) ?? [])[1] ?? '';
  const committerName = committerLine.split(' <')[0];
  const committerEmail = (committerLine.match(/<([^>]*)>/) ?? [])[1] ?? '';
  const date = new Date(REST_TIMESTAMP * 1000).toISOString();
  return {
    sha,
    commit: {
      message,
      author: { name: authorName, email: authorEmail, date },
      committer: { name: committerName, email: committerEmail, date },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN },
    committer: { login: VIEWER_LOGIN },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    tree: { sha: commit.tree },
  };
}

/** A repo the request may touch: only the viewer's repos exist, so any other owner is a 404. */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

// ---------------------------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------------------------

async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  const origin = originOf(req);
  const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readBody(req) : Buffer.alloc(0);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    errorJson(res, 400, `malformed JSON body: ${parsed.error}`);
    return;
  }
  const input = asObject(parsed.value);

  // GET /api/v3/ — the API root.
  if (segments.length === 2 && method === 'GET') {
    sendJson(res, 200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${origin}/api/v3/user/repos`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER_USER.login,
      id: VIEWER_USER.id,
      name: VIEWER_USER.name,
      email: VIEWER_USER.email,
      type: 'User',
      html_url: `https://github.com/${VIEWER_USER.login}`,
      url: `${origin}/api/v3/user`,
    });
    return;
  }

  // POST /api/v3/user/repos — create a repo. GET /api/v3/user/repos — list the viewer's repos.
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        errorJson(res, 422, 'Validation Failed: name is required and must be a valid repository name');
        return;
      }
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: typeof input.description === 'string' ? input.description : '',
        private: input.private === true,
        defaultBranch: typeof input.default_branch === 'string' ? input.default_branch : 'main',
      });
      if (repo === null) {
        sendJson(res, 422, {
          message: 'Validation Failed',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
        return;
      }
      sendJson(res, 201, repoJson(repo, origin));
      return;
    }
    if (method === 'GET') {
      const { page, link } = paginate(req, url, store.listRepos(VIEWER_LOGIN));
      sendJson(res, 200, page.map((repo) => repoJson(repo, origin)), link ? { link } : {});
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[/...]
  if (segments.length < 5 || segments[2] !== 'repos') {
    errorJson(res, 404, 'Not Found');
    return;
  }
  const owner = segments[3];
  const repoName = segments[4];
  const repo = findRepo(store, owner, repoName);
  const rest = segments.slice(5);

  // GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') {
      if (!repo) { errorJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, repoJson(repo, origin));
      return;
    }
    if (method === 'PATCH') {
      if (!repo) { errorJson(res, 404, 'Not Found'); return; }
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      sendJson(res, 200, repoJson(repo, origin));
      return;
    }
    if (method === 'DELETE') {
      if (!repo) { errorJson(res, 404, 'Not Found'); return; }
      store.deleteRepo(owner, repoName);
      sendNoContent(res);
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  if (!repo) {
    errorJson(res, 404, 'Not Found');
    return;
  }

  // --- branches ---------------------------------------------------------------
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: store.peelToCommit(repo.refs.get(`refs/heads/${branch}`)!) ?? '' }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = rest[1];
      const tip = store.branchTip(repo, branch);
      if (tip === null) { errorJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { name: branch, commit: { sha: tip, url: `${origin}/api/v3/repos/${owner}/${repoName}/commits/${tip}` }, protected: false });
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  // --- commits ----------------------------------------------------------------
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      const chain = tip === null ? [] : store.commitChain(store.peelToCommit(tip) ?? tip);
      const { page, link } = paginate(req, url, chain);
      const items = page.map((sha) => commitJson(store, sha, origin, repo)).filter((item): item is Record<string, unknown> => item !== null);
      sendJson(res, 200, items, link ? { link } : {});
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const tip = store.resolveRef(repo, rest[1]);
      const sha = tip === null ? null : store.peelToCommit(tip);
      if (sha === null) { errorJson(res, 404, 'Not Found'); return; }
      const item = commitJson(store, sha, origin, repo);
      if (item === null) { errorJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, item);
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  // --- git refs ---------------------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !store.getObject(sha)) {
        errorJson(res, 422, 'Validation Failed: ref must start with refs/ and sha must name an existing object');
        return;
      }
      if (repo.refs.has(ref)) {
        errorJson(res, 422, 'Validation Failed: Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: store.getObject(sha)!.type, url: `${origin}/api/v3/repos/${owner}/${repoName}/git/refs/${ref}` } });
      return;
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const all = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({
          ref,
          object: { sha, type: store.getObject(sha)?.type ?? 'commit' },
        }));
        sendJson(res, 200, all);
        return;
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) { errorJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { ref, object: { sha, type: store.getObject(sha)?.type ?? 'commit' } });
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  // --- contents ---------------------------------------------------------------
  if (rest[0] === 'contents') {
    const pathSegments = rest.slice(1);
    const branch = typeof url.searchParams.get('ref') === 'string' && url.searchParams.get('ref') !== ''
      ? url.searchParams.get('ref')!
      : typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    if (method === 'GET') {
      const tip = store.branchTip(repo, branch);
      if (tip === null) { errorJson(res, 404, 'Not Found'); return; }
      const tree = parseCommit(store.getObject(tip)!.data).tree;
      if (pathSegments.length === 0) {
        const entries = store.listDir(tree, []) ?? [];
        sendJson(res, 200, entries.map((entry) => contentEntryJson(repo, entry, '', origin)));
        return;
      }
      const found = store.getPath(tree, pathSegments);
      if (found === null) { errorJson(res, 404, 'Not Found'); return; }
      if (found.mode === '40000') {
        const entries = store.listDir(tree, pathSegments) ?? [];
        sendJson(res, 200, entries.map((entry) => contentEntryJson(repo, entry, pathSegments.join('/'), origin)));
        return;
      }
      const object = store.getObject(found.oid);
      if (!object) { errorJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: pathSegments[pathSegments.length - 1],
        path: pathSegments.join('/'),
        content: object.data.toString('base64'),
        sha: found.oid,
        url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${pathSegments.join('/')}`,
        html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${pathSegments.join('/')}`,
        git_url: `${origin}/api/v3/repos/${owner}/${repoName}/git/blobs/${found.oid}`,
        download_url: `${origin}/${owner}/${repoName}/raw/${branch}/${pathSegments.join('/')}`,
      });
      return;
    }
    if (method === 'PUT') {
      if (pathSegments.length === 0) { errorJson(res, 422, 'Validation Failed: a file path is required'); return; }
      const message = typeof input.message === 'string' ? input.message : 'Update file';
      const content = typeof input.content === 'string' ? input.content : '';
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content, 'base64');
      } catch {
        errorJson(res, 422, 'Validation Failed: content must be base64');
        return;
      }
      const existingBranchTip = store.branchTip(repo, branch);
      const baseTip = existingBranchTip ?? (branch === repo.defaultBranch ? null : store.branchTip(repo, repo.defaultBranch));
      const baseTree = baseTip === null ? null : parseCommit(store.getObject(baseTip)!.data).tree;
      const existing = baseTree === null ? null : store.getPath(baseTree, pathSegments);
      if (existing !== null && typeof input.sha === 'string' && input.sha !== '' && input.sha !== existing.oid) {
        errorJson(res, 409, 'Conflict: sha does not match the current file');
        return;
      }
      if (existing === null && typeof input.sha === 'string' && input.sha !== '') {
        errorJson(res, 422, 'Validation Failed: sha names no existing file');
        return;
      }
      const blobOid = store.putObject('blob', bytes);
      const nextTree = store.setPath(baseTree, pathSegments, blobOid) ?? EMPTY_TREE_OID;
      const parents = baseTip === null ? [] : [baseTip];
      const commitSha = store.createCommit(nextTree, parents, message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(res, existing === null ? 201 : 200, {
        content: {
          name: pathSegments[pathSegments.length - 1],
          path: pathSegments.join('/'),
          sha: blobOid,
          size: bytes.length,
          encoding: 'base64',
          type: 'file',
        },
        commit: { sha: commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      if (pathSegments.length === 0) { errorJson(res, 422, 'Validation Failed: a file path is required'); return; }
      const message = typeof input.message === 'string' ? input.message : 'Delete file';
      const tip = store.branchTip(repo, branch);
      if (tip === null) { errorJson(res, 404, 'Not Found'); return; }
      const tree = parseCommit(store.getObject(tip)!.data).tree;
      const existing = store.getPath(tree, pathSegments);
      if (existing === null) { errorJson(res, 404, 'Not Found'); return; }
      if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== existing.oid) {
        errorJson(res, 409, 'Conflict: sha does not match the current file');
        return;
      }
      const nextTree = store.setPath(tree, pathSegments, null) ?? EMPTY_TREE_OID;
      const commitSha = store.createCommit(nextTree, [tip], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  // --- labels -----------------------------------------------------------------
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)));
      return;
    }
    if (method === 'POST' && rest.length === 1) {
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name) { errorJson(res, 422, 'Validation Failed: name is required'); return; }
      if (repo.labels.has(name)) { errorJson(res, 422, 'Validation Failed: label already exists'); return; }
      const color = typeof input.color === 'string' && input.color !== '' ? input.color : 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, labelJson(repo, name));
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  // --- issues -----------------------------------------------------------------
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof input.title === 'string' ? input.title : '';
        if (!title) { errorJson(res, 422, 'Validation Failed: title is required'); return; }
        const labelsArg = Array.isArray(input.labels) ? input.labels.map(String) : [];
        for (const label of labelsArg) {
          if (!repo.labels.has(label)) {
            sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label ${label} does not exist` }] });
            return;
          }
        }
        const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labelsArg);
        sendJson(res, 201, issueJson(repo, issue, origin));
        return;
      }
      if (method === 'GET') {
        let items = [...repo.issues];
        const state = url.searchParams.get('state');
        if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        if (sort === 'created') items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { page, link } = paginate(req, url, items);
        sendJson(res, 200, page.map((issue) => issueJson(repo, issue, origin)), link ? { link } : {});
        return;
      }
      errorJson(res, 404, 'Not Found');
      return;
    }
    const number = Number.parseInt(rest[1], 10);
    const issue = Number.isInteger(number) ? repo.issues.find((entry) => entry.number === number) : undefined;
    if (rest.length === 2) {
      if (method === 'GET') {
        if (!issue) { errorJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, issueJson(repo, issue, origin));
        return;
      }
      if (method === 'PATCH') {
        if (!issue) { errorJson(res, 404, 'Not Found'); return; }
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
        sendJson(res, 200, issueJson(repo, issue, origin));
        return;
      }
      errorJson(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) { errorJson(res, 404, 'Not Found'); return; }
      if (method === 'POST') {
        const commentBody = typeof input.body === 'string' ? input.body : '';
        const comment = { id: repo.nextCommentId, body: commentBody, seq: store.nextSeq() };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        sendJson(res, 201, commentJson(repo, issue, comment, origin));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment, origin)));
        return;
      }
      errorJson(res, 404, 'Not Found');
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  // --- pulls ------------------------------------------------------------------
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof input.title === 'string' ? input.title : '';
        const head = typeof input.head === 'string' ? input.head : '';
        const base = typeof input.base === 'string' && input.base !== '' ? input.base : repo.defaultBranch;
        if (!title || !head) { errorJson(res, 422, 'Validation Failed: title and head are required'); return; }
        const headSha = store.branchTip(repo, head);
        const baseSha = store.branchTip(repo, base);
        if (headSha === null || baseSha === null) {
          errorJson(res, 422, 'Validation Failed: head or base branch not found');
          return;
        }
        const pull = store.createPull(repo, {
          title,
          body: typeof input.body === 'string' ? input.body : '',
          head,
          base,
          headSha,
          baseSha,
        });
        sendJson(res, 201, pullJson(store, repo, pull, origin));
        return;
      }
      if (method === 'GET') {
        let items = [...repo.pulls];
        const state = url.searchParams.get('state') ?? 'open';
        if (state === 'open') items = items.filter((pull) => pull.state === 'open');
        else if (state === 'closed') items = items.filter((pull) => pull.state !== 'open');
        const { page, link } = paginate(req, url, items);
        sendJson(res, 200, page.map((pull) => pullJson(store, repo, pull, origin)), link ? { link } : {});
        return;
      }
      errorJson(res, 404, 'Not Found');
      return;
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = Number.isInteger(number) ? repo.pulls.find((entry) => entry.number === number) : undefined;
    if (rest.length === 2) {
      if (method === 'GET') {
        if (!pull) { errorJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, pullJson(store, repo, pull, origin));
        return;
      }
      errorJson(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method === 'GET') {
        if (!pull) { errorJson(res, 404, 'Not Found'); return; }
        const baseObject = store.getObject(pull.baseSha);
        const headObject = store.getObject(pull.headSha);
        if (!baseObject || baseObject.type !== 'commit' || !headObject || headObject.type !== 'commit') {
          sendJson(res, 200, []);
          return;
        }
        const baseTree = parseCommit(baseObject.data).tree;
        const headTree = parseCommit(headObject.data).tree;
        const files = store.diffTrees(baseTree, headTree).map((change) => ({
          filename: change.path,
          status: change.status === 'modified' ? 'modified' : change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          blob_url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${change.path}`,
          raw_url: `${origin}/${owner}/${repoName}/raw/${pull.headRef}/${change.path}`,
          contents_url: `${origin}/api/v3/repos/${owner}/${repoName}/contents/${change.path}`,
          patch: '',
        }));
        sendJson(res, 200, files);
        return;
      }
      errorJson(res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method === 'PUT') {
        if (!pull) { errorJson(res, 404, 'Not Found'); return; }
        const result = store.squashMerge(repo, pull);
        if ('error' in result) {
          if (result.error === 'not-open') errorJson(res, 405, 'Pull request is already merged or closed');
          else if (result.error === 'not-found') errorJson(res, 404, 'Not Found');
          else errorJson(res, 405, 'Merge conflict: the pull request cannot be merged');
          return;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: pull.title });
        return;
      }
      errorJson(res, 404, 'Not Found');
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }

  errorJson(res, 404, 'Not Found');
}

function contentEntryJson(repo: Repo, entry: { mode: string; name: string; oid: string }, dir: string, origin: string): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: 0,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
    git_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
    download_url: entry.mode === '40000' ? null : `${origin}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
  };
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

/** All of a repo's refs, sorted by name (deterministic advertisement order). */
function repoRefsSorted(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, oid]) => ({ name, oid }));
}

/** The v0 advertisement: the service preamble, then refs with capabilities on the first line. */
function advertisementV0(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta agent=${AGENT_NAME} object-format=sha1 symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT_NAME} object-format=sha1 symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = repoRefsSorted(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0 || headTip === undefined) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    lines.push(`${headTip} HEAD\u0000${caps}\n`);
  }
  for (const { name, oid } of refs) {
    lines.push(`${oid} ${name}\n`);
    const object = store.getObject(oid);
    if (object?.type === 'tag') {
      const commit = store.peelToCommit(oid);
      if (commit !== null) lines.push(`${commit} ${name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 capability advertisement: 'version 2' first, no service preamble. */
function advertisementV2(repo: Repo): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT_NAME}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

async function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  url: URL,
): Promise<void> {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    errorJson(res, 400, 'info/refs needs service=git-upload-pack or service=git-receive-pack');
    return;
  }
  const repo = findRepo(store, owner, repoName);
  if (!repo) {
    errorJson(res, 404, 'Not Found');
    return;
  }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = isV2 ? advertisementV2(repo) : advertisementV0(store, repo, service);
  sendRaw(res, 200, body, `application/x-${service}-advertisement`);
}

/** v2 ls-refs: refs matching the prefixes, with HEAD, peel and unborn handling. */
function handleLsRefs(
  store: Store,
  repo: Repo,
  options: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): Buffer {
  const keep = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (defaultTip === undefined) {
      if (options.unborn) {
        lines.push(`unborn HEAD${options.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
      }
    } else {
      lines.push(`${defaultTip} HEAD${options.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const { name, oid } of repoRefsSorted(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    const object = store.getObject(oid);
    if (options.peel && object?.type === 'tag') {
      const commit = store.peelToCommit(oid);
      if (commit !== null) line += ` peeled:${commit}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

/** Every tree and blob under `treeOid`, added to `out` (gitlinks skipped). */
function addTreeClosure(store: Store, treeOid: string, out: Set<string>): void {
  const object = store.getObject(treeOid);
  if (!object || object.type !== 'tree' || out.has(treeOid)) return;
  out.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '160000') continue;
    if (entry.mode === '40000') addTreeClosure(store, entry.oid, out);
    else out.add(entry.oid);
  }
}

interface FetchResult {
  acks: string[];
  nak: boolean;
  shallow: string[];
  unshallow: string[];
  pack: Buffer;
}

/**
 * The fetch send-set, from the client's wants, haves, shallow boundaries and depth.
 * Wants resolve to tip commits (a tag want also sends the tag object); included commits are the
 * BFS from the tips with distance < depth; new shallow boundaries are the commits at distance
 * depth - 1; unshallow are old boundaries that are included but no longer boundaries. The pack
 * is the included objects minus the objects reachable from the haves (stopping at old shallow
 * boundaries), as plain objects, sorted by oid for determinism.
 */
function computeFetch(store: Store, repo: Repo, request: FetchRequest): FetchResult {
  const tips = new Set<string>();
  const extra = new Set<string>();
  for (const want of request.wants) {
    const object = store.getObject(want);
    if (!object) continue;
    if (object.type === 'commit') tips.add(want);
    else if (object.type === 'tag') {
      const commit = store.peelToCommit(want);
      if (commit !== null) tips.add(commit);
      extra.add(want);
    } else {
      extra.add(want);
    }
  }
  const depth = request.depth;
  const included = new Set<string>();
  const boundary = new Set<string>();
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = [...tips].map((tip) => [tip, 0] as [string, number]);
  while (queue.length) {
    const [oid, d] = queue.shift()!;
    if (distance.has(oid)) continue;
    distance.set(oid, d);
    if (depth !== undefined && d >= depth) continue;
    included.add(oid);
    if (depth !== undefined && d === depth - 1) {
      boundary.add(oid);
    } else {
      const object = store.getObject(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push([parent, d + 1]);
      }
    }
  }
  const oldBoundaries = new Set(request.shallow);
  const unshallow: string[] = [];
  for (const old of oldBoundaries) {
    if (included.has(old) && !boundary.has(old)) unshallow.push(old);
  }
  const includedObjects = new Set<string>(extra);
  for (const commitOid of included) {
    includedObjects.add(commitOid);
    const object = store.getObject(commitOid);
    if (object?.type === 'commit') addTreeClosure(store, parseCommit(object.data).tree, includedObjects);
  }
  const hasSet = new Set<string>();
  const haveQueue = [...request.haves];
  while (haveQueue.length) {
    const oid = haveQueue.pop()!;
    if (hasSet.has(oid)) continue;
    const object = store.getObject(oid);
    if (!object) continue;
    hasSet.add(oid);
    if (object.type === 'commit') {
      addTreeClosure(store, parseCommit(object.data).tree, hasSet);
      if (oldBoundaries.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) haveQueue.push(parent);
    } else if (object.type === 'tag') {
      haveQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      addTreeClosure(store, oid, hasSet);
    }
  }
  const reachableFromRefs =
    request.haves.length === 0
      ? null
      : collectReachable([...repo.refs.values()], (oid) => store.getObject(oid), { allowMissing: true });
  const acks = reachableFromRefs === null ? [] : request.haves.filter((have) => reachableFromRefs.has(have));
  const send = [...includedObjects].filter((oid) => !hasSet.has(oid)).sort();
  const pack = writePack(
    send.map((oid) => {
      const object = store.getObject(oid)!;
      return { type: object.type, data: object.data };
    }),
  );
  return {
    acks,
    nak: acks.length === 0,
    shallow: [...boundary].sort(),
    unshallow: unshallow.sort(),
    pack,
  };
}

/** Frame `data` as sideband band-1 packets (each pkt-line carries at most 65515 data bytes). */
function sidebandPackets(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65515) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

function buildV2FetchResponse(result: FetchResult): Buffer {
  const parts: Buffer[] = [];
  const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
  if (result.nak) {
    ackLines.push('NAK\n');
  } else {
    for (const ack of result.acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  }
  ackLines.push('delim');
  parts.push(encodePktLines(ackLines));
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of result.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of result.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('delim');
    parts.push(encodePktLines(shallowLines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPackets(result.pack));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

function buildV0FetchResponse(result: FetchResult): Buffer {
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (result.nak) lines.push('NAK\n');
  else for (const ack of result.acks) lines.push(`ACK ${ack}\n`);
  for (const oid of result.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of result.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  parts.push(sidebandPackets(result.pack));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

function parseFetchArgs(args: readonly string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  return { wants, haves, shallow, depth };
}

async function handleUploadPack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): Promise<void> {
  const repo = findRepo(store, owner, repoName);
  if (!repo) {
    errorJson(res, 404, 'Not Found');
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (err) {
    errorJson(res, 400, `invalid pkt-line stream: ${(err as Error).message}`);
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    const first = packets.find((packet) => packet.kind === 'data');
    if (!first || first.kind !== 'data') {
      errorJson(res, 400, 'empty v2 request');
      return;
    }
    const command = first.payload.toString('utf8').replace(/\n$/, '');
    const args: string[] = [];
    let seenDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        seenDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data' && seenDelim) args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'command=ls-refs') {
      const argSet = new Set(args);
      const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
      sendRaw(
        res,
        200,
        handleLsRefs(store, repo, { peel: argSet.has('peel'), symrefs: argSet.has('symrefs'), unborn: argSet.has('unborn'), prefixes }),
        'application/x-git-upload-pack-result',
      );
      return;
    }
    if (command === 'command=fetch') {
      const result = computeFetch(store, repo, parseFetchArgs(args));
      sendRaw(res, 200, buildV2FetchResponse(result), 'application/x-git-upload-pack-result');
      return;
    }
    errorJson(res, 400, `unknown v2 command ${JSON.stringify(command)}`);
    return;
  }
  // v0: two sections — wants (with shallow/deepen), then haves and done — each ended by a flush.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data') sections[sections.length - 1].push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const firstSection = sections[0] ?? [];
  const secondSection = sections[1] ?? [];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of firstSection) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  for (const line of secondSection) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const result = computeFetch(store, repo, { wants, haves, shallow, depth });
  sendRaw(res, 200, buildV0FetchResponse(result), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): Promise<void> {
  const repo = findRepo(store, owner, repoName);
  if (!repo) {
    errorJson(res, 404, 'Not Found');
    return;
  }
  // The command list is pkt-lines up to a flush; everything after it is the raw pack.
  const decoder = new PktLineDecoder(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let sawFlush = false;
  try {
    for (;;) {
      const packet = decoder.next();
      if (packet === null) break;
      if (packet.kind === 'flush') {
        packBytes = decoder.takeBuffered();
        sawFlush = true;
        break;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\u0000');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      const parts = clean.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) {
        errorJson(res, 400, `bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
        return;
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  } catch (err) {
    errorJson(res, 400, `invalid pkt-line stream: ${(err as Error).message}`);
    return;
  }
  if (!sawFlush) {
    errorJson(res, 400, 'receive-pack command list has no terminating flush');
    return;
  }
  // Unpack first: a refused ref still leaves its objects in the store.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      if (!read.checksumOk) throw new Error('pack trailer checksum mismatch');
      for (const [oid, object] of read.objects) {
        if (!store.getObject(oid)) store.putObject(object.type, object.data);
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObject = store.getObject(command.newOid);
    if (!newObject) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && store.peelToCommit(command.newOid) === null) {
      results.push({ ref: command.ref, ok: false, reason: 'not a commit' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!store.isAncestor(command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const reportLines: string[] = [unpackError !== null ? 'unpack error\n' : 'unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = encodePktLines(reportLines);
  const response = Buffer.concat([sidebandPackets(report), encodePktLines(['flush'])]);
  sendRaw(res, 200, response, 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------------------------

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = pathSegments(url.pathname);
  if (segments === null) {
    errorJson(res, 400, 'malformed URL');
    return;
  }
  // GET /healthz — the only endpoint without authentication.
  if (segments.length === 1 && segments[0] === 'healthz' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }
  // POST /mcp — authentication is decided inside the MCP handler (tools/call, tools/list).
  if (segments.length === 1 && segments[0] === 'mcp' && req.method === 'POST') {
    const body = await readBody(req);
    const result = handleMcp(store, body.toString('utf8'), isAuthorized(req));
    if (result.json === null) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.json);
    return;
  }
  if (!isAuthorized(req)) {
    errorJson(res, 401, 'Unauthorized: a Bearer token is required');
    return;
  }
  // POST /api/graphql
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql' && req.method === 'POST') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 200, { data: null, errors: [{ message: `malformed JSON body: ${parsed.error}` }] });
      return;
    }
    const result = handleGraphQL(store, parsed.value);
    sendJson(res, result.status, result.json);
    return;
  }
  // /api/v3/...
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest(store, req, res, segments, url);
    return;
  }
  // /<owner>/<repo>.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && req.method === 'GET') {
      await handleInfoRefs(store, req, res, owner, repoName, url);
      return;
    }
    if (segments.length === 3 && segments[2] === 'git-upload-pack' && req.method === 'POST') {
      const body = await readBody(req);
      await handleUploadPack(store, req, res, owner, repoName, body);
      return;
    }
    if (segments.length === 3 && segments[2] === 'git-receive-pack' && req.method === 'POST') {
      const body = await readBody(req);
      await handleReceivePack(store, req, res, owner, repoName, body);
      return;
    }
    errorJson(res, 404, 'Not Found');
    return;
  }
  errorJson(res, 404, 'Not Found');
}

/** Create the forge's HTTP server (one fresh store per server). */
export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const server = createServer((req, res) => {
    handleRequest(store, req, res).catch((err: unknown) => {
      console.error('request failed', err);
      if (!res.headersSent) errorJson(res, 500, `internal error: ${(err as Error).message}`);
      else res.end();
    });
  });
  return server;
}
