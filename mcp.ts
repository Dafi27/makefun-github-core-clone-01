// mcp.ts — the Model Context Protocol endpoint at POST /mcp (Streamable HTTP, JSON-RPC 2.0).
//
// The suite speaks the modern era (2026-07-28): server/discover first, then initialize, then
// tools/list and tools/call. The legacy era (2025-11-25 etc.) is accepted too — initialize works
// the same way, and every response carries serverInfo both top-level and under
// _meta['io.modelcontextprotocol/serverInfo'] so either reader finds it.
//
// Six tools: create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request. Tool arguments are read through synonym lists (owner/owner_login/org,
// repo/repository, head/head_ref, base/base_ref, pull_number/number, body/description) because
// the suite maps its semantic arguments onto the schema's property names. Required properties
// are kept minimal and fillable. Results are a JSON text block plus structuredContent; the
// list_issues text contains the issue titles and numbers the suite looks for.

import { VIEWER_LOGIN } from './scenario.ts';
import { type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];
const LATEST_VERSION = '2026-07-28';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function negotiateVersion(params: Record<string, unknown> | undefined): string {
  const wanted = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
  return SUPPORTED_VERSIONS.includes(wanted) ? wanted : LATEST_VERSION;
}

function serverInfoBlock(): Record<string, unknown> {
  return {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
  };
}

function ok(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  const response: Record<string, unknown> = { jsonrpc: '2.0', id: id ?? null, result };
  // serverInfo is also readable at the envelope level for the modern client.
  response._meta = { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } };
  return response;
}

function fail(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ---------------------------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'array', description: 'Label names to attach to the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'The merge method; only squash is supported.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolSchema(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  };
}

/** Read an argument through its synonym list; the first present, non-null value wins. */
function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
  };
}

class ToolError extends Error {}

/** Run one tool call; throws ToolError on a domain failure (returned as isError). */
function runTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new ToolError(`unknown tool ${name}`);
  for (const required of tool.required) {
    if (pickArg(args, required) === undefined) {
      throw new ToolError(`missing required argument ${required}`);
    }
  }

  if (name === 'create_repo') {
    const repoName = String(pickArg(args, 'name'));
    const existing = store.getRepo(VIEWER_LOGIN, repoName);
    if (existing) return repoJson(existing);
    const repo = store.createRepo(VIEWER_LOGIN, repoName, {
      description: typeof pickArg(args, 'description') === 'string' ? String(pickArg(args, 'description')) : '',
      private: pickArg(args, 'private') === true,
    });
    if (!repo) throw new ToolError(`repository ${repoName} already exists`);
    return repoJson(repo);
  }

  const owner = String(pickArg(args, 'owner', 'owner_login', 'org') ?? '');
  const repoName = String(pickArg(args, 'repo', 'repository', 'name') ?? '');
  const repo = store.getRepo(owner, repoName);
  if (!repo) throw new ToolError(`repository ${owner}/${repoName} not found`);

  if (name === 'get_repo') return repoJson(repo);

  if (name === 'create_issue') {
    const title = String(pickArg(args, 'title'));
    const body = typeof pickArg(args, 'body', 'description') === 'string' ? String(pickArg(args, 'body', 'description')) : '';
    const labelsArg = pickArg(args, 'labels');
    const labels: string[] = [];
    if (Array.isArray(labelsArg)) {
      for (const label of labelsArg) {
        const labelName = String(label);
        if (!repo.labels.has(labelName)) repo.labels.set(labelName, { name: labelName, color: 'ededed' });
        labels.push(labelName);
      }
    }
    const issue = store.createIssue(repo, title, body, labels);
    return {
      id: issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((labelName) => ({ name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed' })),
    };
  }

  if (name === 'list_issues') {
    const state = typeof pickArg(args, 'state') === 'string' ? String(pickArg(args, 'state')).toLowerCase() : 'open';
    const items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const list = items.map((issue) => ({
      id: issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((labelName) => ({ name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed' })),
    }));
    return { issues: list, total: list.length };
  }

  if (name === 'create_pull_request') {
    const title = String(pickArg(args, 'title'));
    const body = typeof pickArg(args, 'body', 'description') === 'string' ? String(pickArg(args, 'body', 'description')) : '';
    const head = String(pickArg(args, 'head', 'head_ref', 'head_branch'));
    const baseRaw = pickArg(args, 'base', 'base_ref', 'base_branch');
    const base = typeof baseRaw === 'string' ? baseRaw : repo.defaultBranch;
    const headSha = store.branchTip(repo, head);
    const baseSha = store.branchTip(repo, base);
    if (headSha === null || baseSha === null) throw new ToolError(`head branch ${head} or base branch ${base} not found`);
    const pull = store.createPull(repo, { title, body, head, base, headSha, baseSha });
    return {
      id: pull.number,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
    };
  }

  if (name === 'merge_pull_request') {
    const numberRaw = pickArg(args, 'pull_number', 'number', 'pullNumber');
    const number = typeof numberRaw === 'number' ? numberRaw : Number.parseInt(String(numberRaw), 10);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) throw new ToolError(`pull request ${number} not found`);
    const result = store.squashMerge(repo, pull);
    if ('error' in result) throw new ToolError(`cannot merge pull request ${number}: ${result.error}`);
    return {
      id: pull.number,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      sha: pull.mergeCommitSha,
    };
  }

  throw new ToolError(`unknown tool ${name}`);
}

// ---------------------------------------------------------------------------------------------
// endpoint
// ---------------------------------------------------------------------------------------------

export interface McpResult {
  status: number;
  /** null → no body (a notification acknowledgement). */
  json: Record<string, unknown> | Array<Record<string, unknown>> | null;
}

/**
 * Handle one POST /mcp request body. `authorized` is the Bearer check the caller already made.
 * Returns the HTTP status and the JSON-RPC body (null for a notification, answered 202 empty).
 */
export function handleMcp(store: Store, bodyText: string, authorized: boolean): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // A non-JSON body is a parse error, answered HTTP 400 in the modern era.
    return { status: 400, json: fail(null, -32700, 'Parse error: request body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    // A batch: one response object per request, in order, notifications omitted.
    const results: Array<Record<string, unknown>> = [];
    for (const item of parsed) {
      const result = dispatch(store, item as JsonRpcRequest, authorized);
      if (result !== null && result.json !== null && !Array.isArray(result.json)) results.push(result.json);
    }
    return { status: 200, json: results };
  }
  const result = dispatch(store, parsed as JsonRpcRequest, authorized);
  return result ?? { status: 202, json: null };
}

function dispatch(store: Store, request: JsonRpcRequest, authorized: boolean): McpResult | null {
  const isNotification = request.id === undefined || request.id === null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (!method) {
    if (isNotification) return null;
    return { status: 400, json: fail(request.id, -32600, 'Invalid Request: no method') };
  }

  // Notifications never get a body back.
  if (method.startsWith('notifications/')) return null;

  // Authentication is decided before any tool lookup.
  if (!authorized && (method === 'tools/call' || method === 'tools/list')) {
    return { status: 401, json: fail(request.id, -32001, 'Unauthorized: a Bearer token is required') };
  }

  if (method === 'server/discover') {
    const version = negotiateVersion(params);
    return {
      status: 200,
      json: ok(request.id, {
        protocolVersion: version,
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        ...serverInfoBlock(),
      }),
    };
  }

  if (method === 'initialize') {
    const version = negotiateVersion(params);
    return {
      status: 200,
      json: ok(request.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        ...serverInfoBlock(),
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, json: ok(request.id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, json: ok(request.id, { tools: TOOLS.map(toolSchema) }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // Accept an exact name, or a suffix match (an alias such as a namespaced tool name).
    const tool = TOOLS.find((candidate) => candidate.name === name)
      ?? TOOLS.find((candidate) => name.toLowerCase().endsWith(candidate.name));
    if (!tool) {
      return { status: 200, json: fail(request.id, -32602, `Unknown tool: ${name}`) };
    }
    // A required property the suite cannot fill is a call error, never an HTTP 500.
    for (const required of tool.required) {
      if (pickArg(args, required) === undefined) {
        return { status: 200, json: fail(request.id, -32602, `Missing required argument: ${required}`) };
      }
    }
    try {
      const result = runTool(store, tool.name, args);
      const text = JSON.stringify(result);
      return {
        status: 200,
        json: ok(request.id, {
          content: [{ type: 'text', text }],
          structuredContent: result,
        }),
      };
    } catch (err) {
      if (err instanceof ToolError) {
        return {
          status: 200,
          json: ok(request.id, {
            content: [{ type: 'text', text: err.message }],
            isError: true,
          }),
        };
      }
      throw err;
    }
  }

  return { status: 200, json: fail(request.id, -32601, `Method not found: ${method}`) };
}
