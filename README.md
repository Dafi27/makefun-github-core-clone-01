# github-core-clone-01 — a GitHub-compatible git forge

A single-process Node 22 server that speaks the pieces of GitHub the make.fun
`github-core-clone-01` suite grades: git smart HTTP (protocol v2 and v0,
shallow fetch, push with report-status), the REST API under `/api/v3`, GraphQL
at `/api/graphql`, and MCP tools at `/mcp`.

- **Owner:** [Dafi27](https://github.com/Dafi27)
- **Repo:** `Dafi27/makefun-github-core-clone-01`
- **Referral code:** `tm9bafze`
- **Bounty:** [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) — $500 in USDC

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL`, and waits for the suite to say the trial is done. There
are no dependencies and no install step: Node 22's standard library only.

## Layout

- `main.ts` — the entry ↔ env lifecycle (starter, unchanged).
- `app.ts` — the HTTP server: REST, git smart HTTP, routing, auth.
- `gitproto.ts` — the git object model, pkt-line codec and packfile read/write.
- `scenario.ts` — the seeded scenario's user generation (viewer `adaiversen`).
- `store.ts` — the in-memory model: repos, refs, issues, pull requests, trees.
- `graphql.ts` — a small GraphQL executor for the suite's documents.
- `mcp.ts` — the MCP endpoint (Streamable HTTP, JSON-RPC 2.0, six tools).

## What it implements

- **Git:** protocol v2 (`ls-refs` with peel/symrefs/unborn/ref-prefix, `fetch`
  with thin-pack, shallow/deepen, unshallow) and protocol v0 upload-pack and
  receive-pack (report-status, side-band-64k, delete-refs); real SHA-1
  objects, byte-exact trees/commits/tags, pack v2 with a verified trailer,
  OFS/REF delta resolution, fast-forward enforcement with the exact
  `non-fast-forward` refusal.
- **REST:** repos (create/read/patch/delete, pagination with `Link`),
  branches, commits, git refs, contents (create/update/delete with SHA
  checks), labels, issues (create/list/get/patch/comments, label validation),
  pull requests (create/list/get/files, squash merge with conflict detection).
- **GraphQL:** viewer, repository, node, `__type` introspection, issue and
  pull-request connections with cursor pagination, and the create/close/merge/
  comment mutations, with opaque base64 global ids.
- **MCP:** `server/discover` (2026-07-28 era), `initialize`, `tools/list` and
  six tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

Authentication is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` on every
endpoint except `GET /healthz`. The store is in-memory and deterministic:
generated commits carry a fixed timestamp and author, so two runs on the same
instance leave the same state.

## License

MIT — see `LICENSE`.
