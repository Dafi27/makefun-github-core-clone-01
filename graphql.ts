// graphql.ts — a small GraphQL executor for the documents the suite sends to POST /api/graphql.
//
// The suite speaks a fixed set of documents (viewer, repository fields, __type probes, issue and
// pull-request lists and mutations, node(), batched operations). This module implements exactly
// that surface: a tokenizer and recursive-descent parser for operations, variables, aliases,
// arguments, inline fragments and __type; a validator that rejects unknown fields with the
// field's name in the message; and resolvers over the store. Unknown fields are a 200 with an
// errors array (GraphQL's convention), never a 400.
//
// Global ids are opaque base64url strings (never the plain database id): `repo:<id>`,
// `issue:<repoId>:<number>`, `pr:<repoId>:<number>`, `user:<id>`.

import { parseCommit } from './gitproto.ts';
import { VIEWER_USER } from './scenario.ts';
import { seqTimestamp, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------------------------

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly selections: SelectionNode[] | null;
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string;
  readonly selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Record<string, unknown>;
  readonly selections: SelectionNode[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' }
  | { kind: 'eof'; value: '' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= source.length) throw new Error('unterminated string in GraphQL document');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value as 'query' | 'mutation';
      this.next();
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.parseVariableDefinitions(variables);
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseVariableDefinitions(variables: Record<string, unknown>): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        variables[name] = this.parseValue({});
      } else {
        variables[name] = undefined;
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      this.expectName('on');
      const typeCondition = this.expectName();
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.parseArguments(args);
    }
    // Tolerate a directive (@name or @name(args)) after the field; the suite sends none.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        const ignored: Record<string, unknown> = {};
        this.parseArguments(ignored);
      }
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name: fieldName, args, selections };
  }

  private parseArguments(args: Record<string, unknown>): void {
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(args);
    }
    this.expectPunct(')');
  }

  private parseValue(variables: Record<string, unknown>): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.expectName();
      return { __variable: name };
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number.parseInt(token.value, 10);
    if (token.kind === 'float') return Number.parseFloat(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        list.push(this.parseValue(variables));
      }
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue(variables);
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)} as a GraphQL value`);
  }
}

/** Substitute $variables in a parsed value (recursively). */
function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in (value as Record<string, unknown>)) {
      return variables[(value as { __variable: string }).__variable] ?? null;
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as { __enum: string }).__enum;
    }
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveValue(item, variables);
    }
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// schema (validation + __type)
// ---------------------------------------------------------------------------------------------

/** Field names each type exposes; `__typename` is allowed on every type. */
const SCHEMA: Readonly<Record<string, ReadonlySet<string>>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['id', 'login', 'name', 'email']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url',
  ]),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PageInfo: new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']),
  PullRequest: new Set([
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'url',
  ]),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'totalCount']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changes']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  IssueComment: new Set(['id', 'body', 'author', 'createdAt']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
};

/** The object type a field returns (for validating nested selections); absent = scalar. */
const FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
  Issue: { author: 'User' },
  IssueComment: { author: 'User' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

/** The fields and enum values __type reports for the types the suite probes. */
const TYPE_INFO: Readonly<Record<string, { kind: string; fields: string[]; enumValues: string[] }>> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'assignees'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'reviews'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'url', 'issues', 'pullRequests', 'issue', 'pullRequest', 'createdAt', 'updatedAt', 'isPrivate', 'forkCount', 'stargazerCount'],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'PULL_REQUEST', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL'],
  },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
};

/** Validate one operation's selections against the schema; returns error messages (empty = valid). */
function validateSelections(selections: SelectionNode[], typeName: string, errors: string[]): void {
  const fields = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (SCHEMA[selection.typeCondition] !== undefined) {
        validateSelections(selection.selections, selection.typeCondition, errors);
      }
      continue;
    }
    if (selection.name === '__typename') continue;
    if (typeName === 'Node') {
      // node() returns an interface: only inline fragments name a concrete type.
      continue;
    }
    if (fields === undefined || !fields.has(selection.name)) {
      errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
      continue;
    }
    if (selection.selections !== null) {
      const childType = FIELD_TYPES[typeName]?.[selection.name];
      if (childType !== undefined && childType !== 'Node') {
        validateSelections(selection.selections, childType, errors);
      } else if (childType === 'Node') {
        validateSelections(selection.selections, 'Node', errors);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

/** A resolved value: scalars pass through; objects carry their type and domain record. */
type Resolved =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; user: { id: number; login: string; name: string; email: string } }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; items: Issue[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; totalCount: number }
  | { __typename: 'PullRequestConnection'; repo: Repo; items: Pull[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; totalCount: number }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null }
  | { __typename: 'PullRequestChangedFileConnection'; files: Array<{ path: string; additions: number; deletions: number; changes: number }> }
  | { __typename: 'PullRequestChangedFile'; file: { path: string; additions: number; deletions: number; changes: number } }
  | { __typename: 'CreateIssuePayload'; issue: Issue | null; repo: Repo | null; clientMutationId: string | null }
  | { __typename: 'CloseIssuePayload'; issue: Issue | null; repo: Repo | null; clientMutationId: string | null }
  | { __typename: 'CreatePullRequestPayload'; pull: Pull | null; repo: Repo | null; clientMutationId: string | null }
  | { __typename: 'MergePullRequestPayload'; pull: Pull | null; repo: Repo | null; clientMutationId: string | null }
  | { __typename: 'AddCommentPayload'; comment: { id: number; body: string; seq: number } | null; repo: Repo | null; issue: Issue | null; clientMutationId: string | null }
  | { __typename: 'IssueCommentEdge'; comment: { id: number; body: string; seq: number }; repo: Repo; issue: Issue }
  | { __typename: 'IssueComment'; comment: { id: number; body: string; seq: number }; repo: Repo; issue: Issue }
  | { __typename: '__Type'; name: string; kind: string; fields: string[]; enumValues: string[] }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string };

function encodeCursor(kind: string, number: number): string {
  return Buffer.from(`cursor:${kind}:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): { kind: string; number: number } | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'cursor' || parts.length !== 3) return null;
    const number = Number.parseInt(parts[2], 10);
    if (!Number.isInteger(number)) return null;
    return { kind: parts[1], number };
  } catch {
    return null;
  }
}

/** A page of a connection: items after `after`, at most `first`, in the given order. */
function paginate<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
  kind: string,
): { page: T[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null; totalCount: number } {
  const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : items.length;
  const after = decodeCursor(args.after);
  let start = 0;
  if (after !== null && after.kind === kind) {
    const index = items.findIndex((item) => item.number === after.number);
    if (index >= 0) start = index + 1;
  }
  const page = items.slice(start, start + first);
  return {
    page,
    hasNextPage: start + page.length < items.length,
    endCursor: page.length ? encodeCursor(kind, page[page.length - 1].number) : null,
    startCursor: page.length ? encodeCursor(kind, page[0].number) : null,
    totalCount: items.length,
  };
}

class GraphQLError extends Error {}

interface ExecutorContext {
  store: Store;
  errors: Array<{ message: string }>;
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'issue' || decoded.parts.length !== 2) return null;
  const repo = findRepoById(store, Number.parseInt(decoded.parts[0], 10));
  if (!repo) return null;
  const issue = repo.issues.find((entry) => entry.number === Number.parseInt(decoded.parts[1], 10));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'pr' || decoded.parts.length !== 2) return null;
  const repo = findRepoById(store, Number.parseInt(decoded.parts[0], 10));
  if (!repo) return null;
  const pull = repo.pulls.find((entry) => entry.number === Number.parseInt(decoded.parts[1], 10));
  return pull ? { repo, pull } : null;
}

function pullFiles(store: Store, repo: Repo, pull: Pull): Array<{ path: string; additions: number; deletions: number; changes: number }> {
  const baseCommit = store.getObject(pull.baseSha);
  const headCommit = store.getObject(pull.headSha);
  if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') return [];
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  return store.diffTrees(baseTree, headTree).map((change) => ({
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
  }));
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

function executeField(
  ctx: ExecutorContext,
  parent: Resolved,
  field: FieldNode,
  variables: Record<string, unknown>,
): unknown {
  const args = resolveArgs(field.args, variables);
  const { store } = ctx;

  if (parent.__typename === 'Query') {
    if (field.name === 'viewer') return { __typename: 'User', user: VIEWER_USER } satisfies Resolved;
    if (field.name === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? ({ __typename: 'Repository', repo } satisfies Resolved) : null;
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const repo = findRepoById(store, Number.parseInt(decoded.parts[0], 10));
        return repo ? ({ __typename: 'Repository', repo } satisfies Resolved) : null;
      }
      if (decoded.kind === 'issue') {
        const found = findIssueByGlobalId(store, id);
        return found ? ({ __typename: 'Issue', repo: found.repo, issue: found.issue } satisfies Resolved) : null;
      }
      if (decoded.kind === 'pr') {
        const found = findPullByGlobalId(store, id);
        return found ? ({ __typename: 'PullRequest', repo: found.repo, pull: found.pull } satisfies Resolved) : null;
      }
      if (decoded.kind === 'user') {
        return { __typename: 'User', user: VIEWER_USER } satisfies Resolved;
      }
      return null;
    }
    if (field.name === '__type') {
      const info = TYPE_INFO[String(args.name ?? '')];
      if (!info) return null;
      return {
        __typename: '__Type',
        name: String(args.name),
        kind: info.kind,
        fields: info.fields,
        enumValues: info.enumValues,
      } satisfies Resolved;
    }
  }

  if (parent.__typename === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
    if (field.name === 'createIssue') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.kind === 'repo' ? findRepoById(store, Number.parseInt(decoded.parts[0], 10)) : undefined;
      if (!repo) throw new GraphQLError('createIssue: repository not found');
      const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
      const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), labels);
      return { __typename: 'CreateIssuePayload', issue, repo, clientMutationId } satisfies Resolved;
    }
    if (field.name === 'closeIssue') {
      const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
      if (!found) throw new GraphQLError('closeIssue: issue not found');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: found.issue, repo: found.repo, clientMutationId } satisfies Resolved;
    }
    if (field.name === 'createPullRequest') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.kind === 'repo' ? findRepoById(store, Number.parseInt(decoded.parts[0], 10)) : undefined;
      if (!repo) throw new GraphQLError('createPullRequest: repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null || baseSha === null) throw new GraphQLError('createPullRequest: head or base branch not found');
      const pull = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head,
        base,
        headSha,
        baseSha,
      });
      return { __typename: 'CreatePullRequestPayload', pull, repo, clientMutationId } satisfies Resolved;
    }
    if (field.name === 'mergePullRequest') {
      const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
      if (!found) throw new GraphQLError('mergePullRequest: pull request not found');
      const result = store.squashMerge(found.repo, found.pull);
      if ('error' in result) throw new GraphQLError(`mergePullRequest: ${result.error}`);
      return { __typename: 'MergePullRequestPayload', pull: found.pull, repo: found.repo, clientMutationId } satisfies Resolved;
    }
    if (field.name === 'addComment') {
      const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
      if (!found) throw new GraphQLError('addComment: issue not found');
      const comment = { id: found.repo.nextCommentId, body: String(input.body ?? ''), seq: store.nextSeq() };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      return { __typename: 'AddCommentPayload', comment, repo: found.repo, issue: found.issue, clientMutationId } satisfies Resolved;
    }
  }

  if (parent.__typename === 'User') {
    if (field.name === 'id') return encodeGlobalId('user', parent.user.id);
    if (field.name === 'login') return parent.user.login;
    if (field.name === 'name') return parent.user.name;
    if (field.name === 'email') return parent.user.email;
  }

  if (parent.__typename === 'Repository') {
    const repo = parent.repo;
    if (field.name === 'id') return encodeGlobalId('repo', repo.id);
    if (field.name === 'databaseId') return repo.id;
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field.name === 'owner') return { __typename: 'User', user: VIEWER_USER } satisfies Resolved;
    if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch } satisfies Resolved;
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'description') return repo.description;
    if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
    if (field.name === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === Number(args.number));
      return issue ? ({ __typename: 'Issue', repo, issue } satisfies Resolved) : null;
    }
    if (field.name === 'issues') {
      let items = [...repo.issues];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        items = items.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.field === 'CREATED_AT') {
        items.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      } else {
        items.sort((a, b) => a.seq - b.seq);
      }
      const page = paginate(items, args, 'issue');
      return {
        __typename: 'IssueConnection',
        repo,
        items: page.page,
        hasNextPage: page.hasNextPage,
        endCursor: page.endCursor,
        startCursor: page.startCursor,
        totalCount: page.totalCount,
      } satisfies Resolved;
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
      return pull ? ({ __typename: 'PullRequest', repo, pull } satisfies Resolved) : null;
    }
    if (field.name === 'pullRequests') {
      let items = [...repo.pulls];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        items = items.filter((pull) => wanted.has(pull.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.field === 'CREATED_AT') {
        items.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      } else {
        items.sort((a, b) => a.seq - b.seq);
      }
      const page = paginate(items, args, 'pr');
      return {
        __typename: 'PullRequestConnection',
        repo,
        items: page.page,
        hasNextPage: page.hasNextPage,
        endCursor: page.endCursor,
        startCursor: page.startCursor,
        totalCount: page.totalCount,
      } satisfies Resolved;
    }
  }

  if (parent.__typename === 'Ref') {
    if (field.name === 'name') return parent.name;
  }

  if (parent.__typename === 'Issue') {
    const { issue, repo } = parent;
    if (field.name === 'id') return encodeGlobalId('issue', repo.id, issue.number);
    if (field.name === 'databaseId') return issue.number;
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'body') return issue.body;
    if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'author') return { __typename: 'User', user: VIEWER_USER } satisfies Resolved;
    if (field.name === 'createdAt') return seqTimestamp(issue.seq);
    if (field.name === 'updatedAt') return seqTimestamp(issue.seq);
    if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
  }

  if (parent.__typename === 'IssueConnection') {
    if (field.name === 'nodes') return parent.items.map((issue) => ({ __typename: 'Issue', repo: parent.repo, issue }) satisfies Resolved);
    if (field.name === 'totalCount') return parent.totalCount;
    if (field.name === 'pageInfo') {
      return {
        __typename: 'PageInfo',
        hasNextPage: parent.hasNextPage,
        endCursor: parent.endCursor,
        hasPreviousPage: parent.startCursor !== null,
        startCursor: parent.startCursor,
      } satisfies Resolved;
    }
  }

  if (parent.__typename === 'PullRequestConnection') {
    if (field.name === 'nodes') return parent.items.map((pull) => ({ __typename: 'PullRequest', repo: parent.repo, pull }) satisfies Resolved);
    if (field.name === 'totalCount') return parent.totalCount;
    if (field.name === 'pageInfo') {
      return {
        __typename: 'PageInfo',
        hasNextPage: parent.hasNextPage,
        endCursor: parent.endCursor,
        hasPreviousPage: parent.startCursor !== null,
        startCursor: parent.startCursor,
      } satisfies Resolved;
    }
  }

  if (parent.__typename === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.hasNextPage;
    if (field.name === 'endCursor') return parent.endCursor;
    if (field.name === 'hasPreviousPage') return parent.hasPreviousPage;
    if (field.name === 'startCursor') return parent.startCursor;
  }

  if (parent.__typename === 'PullRequest') {
    const { pull, repo } = parent;
    if (field.name === 'id') return encodeGlobalId('pr', repo.id, pull.number);
    if (field.name === 'databaseId') return pull.number;
    if (field.name === 'number') return pull.number;
    if (field.name === 'title') return pull.title;
    if (field.name === 'body') return pull.body;
    if (field.name === 'state') return pull.state === 'open' ? 'OPEN' : pull.state === 'merged' ? 'MERGED' : 'CLOSED';
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'mergeable') return pullMergeable(store, repo, pull);
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    if (field.name === 'headRefOid') return store.peelToCommit(pull.headSha) ?? pull.headSha;
    if (field.name === 'baseRefOid') return store.peelToCommit(pull.baseSha) ?? pull.baseSha;
    if (field.name === 'files') {
      return { __typename: 'PullRequestChangedFileConnection', files: pullFiles(store, repo, pull) } satisfies Resolved;
    }
    if (field.name === 'createdAt') return seqTimestamp(pull.seq);
    if (field.name === 'updatedAt') return seqTimestamp(pull.seq);
    if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
  }

  if (parent.__typename === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') return parent.files.map((file) => ({ __typename: 'PullRequestChangedFile', file }) satisfies Resolved);
    if (field.name === 'totalCount') return parent.files.length;
  }

  if (parent.__typename === 'PullRequestChangedFile') {
    if (field.name === 'path') return parent.file.path;
    if (field.name === 'additions') return parent.file.additions;
    if (field.name === 'deletions') return parent.file.deletions;
    if (field.name === 'changes') return parent.file.changes;
  }

  if (parent.__typename === 'CreateIssuePayload') {
    if (field.name === 'issue') return parent.issue ? ({ __typename: 'Issue', repo: parent.repo!, issue: parent.issue } satisfies Resolved) : null;
    if (field.name === 'clientMutationId') return parent.clientMutationId;
  }
  if (parent.__typename === 'CloseIssuePayload') {
    if (field.name === 'issue') return parent.issue ? ({ __typename: 'Issue', repo: parent.repo!, issue: parent.issue } satisfies Resolved) : null;
    if (field.name === 'clientMutationId') return parent.clientMutationId;
  }
  if (parent.__typename === 'CreatePullRequestPayload' || parent.__typename === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return parent.pull ? ({ __typename: 'PullRequest', repo: parent.repo!, pull: parent.pull } satisfies Resolved) : null;
    if (field.name === 'clientMutationId') return parent.clientMutationId;
  }
  if (parent.__typename === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      return parent.comment
        ? ({ __typename: 'IssueCommentEdge', comment: parent.comment, repo: parent.repo!, issue: parent.issue! } satisfies Resolved)
        : null;
    }
    if (field.name === 'clientMutationId') return parent.clientMutationId;
  }
  if (parent.__typename === 'IssueCommentEdge') {
    if (field.name === 'node') return { __typename: 'IssueComment', comment: parent.comment, repo: parent.repo, issue: parent.issue } satisfies Resolved;
    if (field.name === 'cursor') return encodeCursor('comment', parent.comment.id);
  }
  if (parent.__typename === 'IssueComment') {
    if (field.name === 'id') return encodeGlobalId('comment', parent.repo.id, parent.issue.number, parent.comment.id);
    if (field.name === 'body') return parent.comment.body;
    if (field.name === 'author') return { __typename: 'User', user: VIEWER_USER } satisfies Resolved;
    if (field.name === 'createdAt') return seqTimestamp(parent.comment.seq);
  }
  if (parent.__typename === '__Type') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'kind') return parent.kind;
    if (field.name === 'fields') return parent.fields.map((name) => ({ __typename: '__Field', name }) satisfies Resolved);
    if (field.name === 'enumValues') return parent.enumValues.map((name) => ({ __typename: '__EnumValue', name }) satisfies Resolved);
    if (field.name === 'description') return null;
  }
  if (parent.__typename === '__Field') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'description') return null;
  }
  if (parent.__typename === '__EnumValue') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'description') return null;
  }

  throw new GraphQLError(`no resolver for field "${field.name}" on type "${parent.__typename}"`);
}

function executeSelections(
  ctx: ExecutorContext,
  parent: Resolved,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (parent.__typename === selection.typeCondition) {
        Object.assign(out, executeSelections(ctx, parent, selection.selections, variables));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = parent.__typename;
      continue;
    }
    try {
      const value = executeField(ctx, parent, selection, variables);
      if (selection.selections === null || selection.selections === undefined) {
        out[key] = value;
      } else if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((item) =>
          item !== null && typeof item === 'object' && '__typename' in item
            ? executeSelections(ctx, item as Resolved, selection.selections!, variables)
            : item,
        );
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[key] = executeSelections(ctx, value as Resolved, selection.selections, variables);
      } else {
        out[key] = value;
      }
    } catch (err) {
      if (err instanceof GraphQLError) {
        ctx.errors.push({ message: err.message });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function executeOperation(
  store: Store,
  operation: OperationNode,
  requestVariables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const variables: Record<string, unknown> = { ...operation.variables, ...requestVariables };
  const errors: Array<{ message: string }> = [];
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: string[] = [];
  validateSelections(operation.selections, rootType, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const ctx: ExecutorContext = { store, errors };
  const root: Resolved = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(ctx, root, operation.selections, variables);
  if (errors.length > 0) return { data, errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Execute a GraphQL request body (one request or a batch array). Always answers HTTP 200 with a
 * GraphQL-shaped body; a malformed document is a 200 with errors, matching the suite's client.
 */
export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  const requests = Array.isArray(body) ? body : [body];
  const results = requests.map((request) => {
    const req = (request ?? {}) as Record<string, unknown>;
    const query = typeof req.query === 'string' ? req.query : '';
    const variables = (req.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof req.operationName === 'string' ? req.operationName : null;
    let operations: OperationNode[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
    if (operations.length === 0) return { data: null, errors: [{ message: 'empty GraphQL document' }] };
    let operation = operations[0];
    if (operationName !== null) {
      const named = operations.find((op) => op.name === operationName);
      if (named) operation = named;
    }
    return executeOperation(store, operation, variables);
  });
  return { status: 200, json: Array.isArray(body) ? results : results[0] };
}
