# Configuration

## Server environment variables

Set these on the server container (see [Self-hosting](self-hosting.md)). The server also reads the first env file it finds among `$CAIRN_ENV_FILE`, `./.env` and `~/.cairn/.env`; real environment variables always win.

### Neo4j

| Variable | Default | Description |
| --- | --- | --- |
| `NEO4J_URI` | `bolt://localhost:7687` | Bolt address of Neo4j. Inside Docker use an address the container can reach. |
| `NEO4J_USER` | `neo4j` | Neo4j user |
| `NEO4J_PASSWORD` | `neo4j` | Neo4j password. Change it: the dashboard warns while it is the default. |
| `NEO4J_DATABASE` | server default | Database name, if not the default one |

### HTTP server

| Variable | Default | Description |
| --- | --- | --- |
| `CAIRN_PORT` | `8787` | Port for the dashboard, MCP endpoint and API |
| `CAIRN_HOST` | `0.0.0.0` | Interface to bind |
| `CAIRN_TRUST_PROXY` | off | Set to `1` to believe `X-Forwarded-For` (only behind a proxy you control) |
| `CAIRN_COOKIE_SECURE` | off | Set to `1` to mark dashboard session cookies `Secure` (when served over HTTPS) |

### Access control

| Variable | Default | Description |
| --- | --- | --- |
| `CAIRN_TOKEN` | none | Optional static bearer token for scripts and bootstrap. It acts as the first admin. Tokens created in the dashboard act as the user who created them. |
| `CAIRN_NO_AUTH` | off | Set to `1` to disable authentication entirely: every request acts as the first admin. Trusted networks only. |
| `CAIRN_RESET_ADMIN` | off | Set to `1` for one start to remove all admin accounts and the tokens they created, and print a new setup code. Projects they owned go to the next admin. Members are untouched. |

### Dashboard

| Variable | Default | Description |
| --- | --- | --- |
| `CAIRN_CAPTURE` | `full` | `full` keeps request and response payloads in memory; `meta` keeps only a summary |
| `CAIRN_EVENT_CAPACITY` | `2000` | How many recent requests the Live page keeps |

## Client environment variables

Set these where your agents and the CLI run.

| Variable | Description |
| --- | --- |
| `CAIRN_URL` | Server address without a trailing slash or `/mcp`, for example `http://localhost:8787` |
| `CAIRN_TOKEN` | A token created in the dashboard |
| `CAIRN_ENV_FILE` | Path to an env file for the CLI to read (otherwise `./.env`, then `~/.cairn/.env`) |

Hook tuning (`CAIRN_BRIEFING_TOKENS`, `CAIRN_CHECKPOINT_MIN_EDITS`, `CAIRN_HOOK_TIMEOUT_MS`) and the optional `CAIRN_CLI` override for the hook command are described in [Using it with Claude Code](claude-code.md).

## Files in a linked project

| File | Written by | Contents |
| --- | --- | --- |
| `.cairn.json` | `cairn init` | `{ "projectId": "…" }` |
| `.mcp.json` | `cairn init` | The `cairn` server entry with `${CAIRN_URL}` / `${CAIRN_TOKEN}` placeholders and the project header |
| `.claude/settings.json` or `settings.local.json` | `cairn init` | The SessionStart, Stop and PreToolUse hooks |
| `CLAUDE.md` | `cairn init` | A block between `<!-- cairn:start -->` and `<!-- cairn:end -->` |

## Endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | `200` when Neo4j is reachable, `503` otherwise |
| `POST /mcp` | bearer token | MCP over Streamable HTTP (stateless) |
| `/api/*` | bearer token | JSON API used by the CLI and hooks: `GET /api/project`, `POST /api/init`, `GET /api/stale-inputs`, `POST /api/briefing`, `POST /api/remote`, `POST /api/session` (record a session snapshot), `GET /api/sessions`, `POST /api/resume` |
| `/ui/` | none (the app signs in) | The dashboard |
| `/admin/api/*` | session cookie | The dashboard's own API |
| `/admin/api/invite/<token>` | the link itself | Preview and accept an invitation (public, rate limited) |

Project identity for `/mcp` and `/api` comes from the `X-Cairn-Project` header (a project id, or a project name among the projects the token's user can access) or `X-Cairn-Remote` (a normalized git remote such as `github.com/acme/app`, matched among the user's own projects). A project the token's user cannot access answers as if it did not exist.

A token acts as the user who created it, and every call is checked against that user's role on the project (see [access control](access-control.md)). A request to read or write a project without the needed role is refused with `404` (no access at all) or `403` (not enough role).

## MCP tools

| Tool | Arguments | Notes |
| --- | --- | --- |
| `cairn_briefing` | `max_tokens?` (200–8000, default 1500) | Budgeted briefing; onboarding instructions for an empty project |
| `cairn_recall` | `query?`, `kind?`, `area?`, `limit?`, `include_superseded?`, `sort?` | Fulltext search scoped to the project; `sort` (`importance`, `recent`, `oldest`) applies when not searching text |
| `cairn_remember` | `kind`, `title`, `body`, `area?`, `paths?`, `importance?` (1–5), `supersedes?`, `review_by?` (a day), `revisit_when?` | One fact per memory; ids may be the 8-character short form |
| `cairn_checkpoint` | `goal`, `outcome`, `decisions?`, `next?`, `resolves?`, `area?`, `paths?` | Also files each decision and an open thread for `next` |
| `cairn_areas` | none | Areas with memory counts |
| `cairn_forget` | `id` | Deletes a memory; anything it replaced becomes active again |
| `cairn_handoff` | `goal`, `status?`, `in_progress?`, `next?`, `blockers?`, `assumptions?`, `from_user?`, `dead_ends?` (a line, or `{idea, why?, revisit_if?}`), `done?`, `verify?`, `decisions?`, `paths?`, `topic?` | Where the work stands, for whoever picks it up. Replaces the previous handoff for the same topic. |
| `cairn_resume` | none | The latest handoffs in full, recent sessions, open threads and how to check the repository |
| `cairn_status` | none | Connection, project and counts |

`cairn_remember`, `cairn_checkpoint` and `cairn_handoff` also accept `commit_sha` and `author`, which the PreToolUse hook fills in. The server itself stamps every new memory with the authenticated user and the access token it was written with (shown as "written by" in the dashboard and in recall); the client cannot set those. `cairn mcp` adds one more tool, `cairn_init`, which it answers on your machine (see the [Claude Code guide](claude-code.md#setting-up-from-inside-a-conversation)). Memory kinds are `overview`, `decision`, `convention`, `gotcha`, `checkpoint`, `thread`, `glossary` and `handoff` (written only by `cairn_handoff`).
