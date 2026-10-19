# Architecture

## Components

```
                      ┌────────────────────── Agent Cairn server ──────────────────────┐
 agent ── MCP/HTTP ──►│  /mcp   tools ─► core (memories, briefing, identity)        │
 CLI/hooks ── JSON ──►│  /api   plumbing ─►        │                                │──► Neo4j
 browser ── HTTP ────►│  /ui/ + /admin/api  dashboard, accounts, tokens, recorder   │
                      └─────────────────────────────────────────────────────────────┘
```

| Package | Responsibility |
| --- | --- |
| `core` | Everything that touches the database: schema and migrations, memories (`remember`, `recall`, supersede), briefing assembly, staleness, project identity, accounts and tokens, graph queries for the dashboard |
| `mcp-server` | Transports and policy: MCP tools, the JSON API, authentication, the request recorder, the dashboard (static files plus its API), and a local stdio mode |
| `cli` | The parts that need your working tree: `cairn init`, `doctor`, and the Claude Code hooks |

The server is stateless between requests: each MCP request creates a fresh server instance, so it scales by running more containers against the same Neo4j. The only in-memory state is the dashboard's request recorder, login sessions and rate limiters.

## Why the server never sees your repository

The server usually runs somewhere else (a home server, a VPS). So everything that needs the checkout runs on the client:

- project identity arrives as headers (`X-Cairn-Project` or `X-Cairn-Remote`),
- the SessionStart hook runs `git diff` against each memory's recorded commit and sends up only which memories are stale,
- the PreToolUse hook adds the current commit and author to writes.

A feature that needs files on disk belongs in `cli`, not in the server.

## Data model

Containment is a tree: **Project → Area → Memory**.

```
(Remote)-[:BELONGS_TO]->(Project)-[:HAS_AREA]->(Area)-[:HAS_MEMORY]->(Memory)
                                                         (Memory)-[:SUPERSEDES]->(Memory)
(User)-[:MEMBER_OF {role}]->(Project)      (User)-[:CREATED]->(ApiToken)      (BrainMeta)   // schema version marker
```

| Node | Key properties |
| --- | --- |
| `Project` | `id` (generated, `prj_…`; older projects keep theirs), `name` |
| `Area` | `id` (`<project>:<name>`), `projectId`, `name`. Memories filed without an area go to `general`. |
| `Memory` | `id`, `projectId`, `kind`, `title`, `body`, `importance` (1–5), `status` (`active`/`superseded`), `paths`, `commitSha`, `author`, `agent`, `machine`, `createdAt` |
| `Remote` | `key` (`<project>:<hash>`), `hash`: a sha256 prefix of the normalized git remote, never the URL. One per project, so the same repository can map to different projects for different people |
| `Session` | `key` (`<project>:<session id>`), `id`, `projectId`, `machine`, `agent`, `branch`, `head`, `dirty`, `touched`, `commits`, prompts and last reply (redacted and clipped), `updatedAt`. One per conversation, updated in place. `(Project)-[:HAS_SESSION]->(Session)` |
| `User` | `id`, `username`, `passwordHash` (scrypt), `role` (`admin`/`member`), `status` (`active`/`disabled`). Accounts from before users also keep an `Admin` label for now |
| `ApiToken` | `id`, `name`, `hash` (sha256), `prefix`, `createdAt`, `lastUsedAt`, `revokedAt` |
| `BrainMeta` | One row (`id: 'schema'`) holding the schema version |

Memory kinds: `overview`, `convention`, `gotcha`, `decision`, `checkpoint`, `thread`, `glossary`, `handoff`. A handoff has a `topic` (its branch by default); writing a new one supersedes the active handoff with the same topic.

### Sessions and handoffs

The server cannot see the repository or the conversation, so the client records them. Hooks on the user's machine read the Claude Code transcript and the git state and send a cumulative snapshot of the session to `POST /api/session` after each prompt and turn. Snapshots are idempotent (the same session is updated in place, and a thinner snapshot never erases what was recorded earlier) and never create a project. The briefing opens with the latest handoffs and sessions, and returns `resume` metadata so the client's SessionStart hook can compare this clone with where the work stopped.

Memories are never edited in place. Changing a fact writes a new memory with `supersedes`, which marks the old one `superseded` and links them in one transaction. The transaction fails as a whole if any id is missing, belongs to another project or is already superseded, and a lock taken before the status is read means two concurrent writers cannot both supersede the same memory.

### Schema versions and migrations

`ensureSchema` runs at startup and lazily on first use. It creates constraints and indexes (`IF NOT EXISTS`), converts older data shapes in place (idempotent, detected by shape, not by version number), and records the version. Schema 4 added users, ownership and per-project remote aliases; it only adds to the database (the old `Admin` label stays on accounts, and nothing new is indexed on `Remote.hash`), so a previous server version keeps working against the same database. It uses only plain Cypher that works on Neo4j Community: no APOC, no enterprise features.

## Briefings

`cairn_briefing` fills sections in a fixed priority, each with a share of the token budget plus whatever earlier sections left unused:

| Section | Share | Max items |
| --- | --- | --- |
| Overview | 25% | 4 |
| Conventions | 15% | 8 |
| Gotchas | 15% | 8 |
| Open threads | 10% | 6 |
| Recent checkpoints | 15% | 3 (by recency only) |
| Decisions | 15% | 8 |
| Glossary | 5% | 10 |

Within a section, items rank by importance and recency, minus a penalty for stale memories. An item that does not fit is shortened once, then skipped. The result never exceeds the budget, and a footer says how many memories were left out so the agent can fetch them with `cairn_recall`. No model is involved, so a briefing is cheap and predictable. Token counts are an estimate (about four characters per token).

## Staleness

A memory records the commit it was written at and the paths it concerns. The CLI compares the working tree with that commit (committed and uncommitted changes, deletions and renames included, with literal pathspecs so characters like `*` are not special) and reports changed paths. Memories with no paths or no commit, or a commit the clone does not have, are left unchecked rather than flagged.

## Security model

- **Agents** authenticate with bearer tokens: hashed in Neo4j (shown once at creation), cached for 30 seconds, revocation takes effect immediately. A token acts as the user who created it; a static `CAIRN_TOKEN` acts as the first admin. With no tokens configured, requests are refused.
- **The dashboard** uses a signed-in session (a random id in an `HttpOnly`, `SameSite=Strict` cookie, held in memory, 12 hours). Login and setup-code guesses are rate limited, cross-origin writes are refused, and a strict Content-Security-Policy forbids inline scripts.
- **The first admin** can only be created with a one-time code printed in the server log. The creation is serialized in the database so two simultaneous setups cannot both succeed.
- **Access control** is one function, `authorize(principal, action, project)`, called by every MCP tool, API call and dashboard route, and it denies by default. A project the caller has no role on reads as "not found", so its existence does not leak; a project that cannot be seen resolves to a `pending:` placeholder that can never equal a real id. With one active user the server is in solo mode and the check is skipped. See [access control](access-control.md).
- **Admin-only surfaces**: the request feed, the Cypher console (it reads everything) and the system page. An admin manages accounts; being an admin does not grant access to other people's projects.
- **The Cypher console** is read-only twice over: a keyword screen, and the database runs the statement in a read transaction, which refuses writes whatever the text says.
- **Privacy**: git remotes are stored as hashes, credentials in a remote are dropped client-side, and `Authorization` headers are never recorded.
- **The request recorder** keeps the last 2,000 requests in memory only (summary only with `CAIRN_CAPTURE=meta`). Nothing is persisted.

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).

## The dashboard

`packages/mcp-server/ui` is plain ES modules served as static files, with one vendored library (Cytoscape, from `node_modules`). There is no build step. Live data arrives over Server-Sent Events from `/admin/api/stream`. The graph view lays the tree out radially with the project at the root and highlights nodes when events mention the memories they touched.
