# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project aims to follow [Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

## [0.2.2] - 2026-10-21

- Clearer errors when a write tries to replace a memory: the message now says, per id, whether it is unknown, ambiguous or already replaced, and by which memory to use instead (a retried write used to fail with a generic line). Applies to `cairn_remember` and the threads a checkpoint resolves.
- The Live feed no longer counts an optional `server/discover` probe (sent first by newer Claude Code) as an error; the server still answers it "method not found" and the client falls back.

## [0.2.1] - 2026-10-20

- `cairn init` only tells you to set CAIRN_URL and CAIRN_TOKEN when it wrote a `.mcp.json` that needs them and they are not set; otherwise it just says to restart Claude Code.
- `cairn_handoff` no longer fails when many files are changed (a merge can touch hundreds): the uncommitted-files list has no entry limit.
- The graph looks like the Neo4j Browser: solid coloured nodes with the caption inside, arrows with the relationship type written along them, a node-label and relationship-type overview in the side panel, and a properties table for the selected node. A single project opens in a force layout.
- Existing projects can be given generated `prj_…` ids; old links keep working by name.

## [0.2.0] - 2026-10-20

- **Handoff and resume.** Another agent, on any machine, can pick up where the last one stopped. Sessions are now recorded as they happen (the user's requests, the agent's last message, files edited, commits, uncommitted work, branch and commit), by new UserPromptSubmit, PreCompact and SessionEnd hooks plus the Stop hook. A new `handoff` memory kind and the `cairn_handoff` tool let the agent write what is done, in progress, next, blocked and tried and dropped; `cairn_resume` and `cairn resume` return everything in full. The briefing opens with where the work was left, and the SessionStart hook checks this clone against it (a commit that was never pushed, uncommitted work on another machine). Prompts and replies are filtered for secrets on the machine and again on the server; `CAIRN_SESSION_CAPTURE=meta` sends no words and `off` sends nothing. Existing projects get the new hooks by running `cairn init` again.
- The project page lists memories newest first by default, with a sort (newest, oldest, most important), shows the latest handoff and a timeline of sessions.
- The graph no longer draws every project, area and git remote at once: the overview shows projects as bubbles sized by how much they remember (quiet ones fade), a click opens a project's areas, a double-click explores its memories, and Areas and Git remotes toggles show the rest.

- **Users, private projects and roles.** Projects belong to the user who made them. Each has a generated id (`prj_…`) and a name; names may repeat. Roles on a project: viewer, editor, maintainer, owner. Tokens act as the user who created them, git-remote aliases are per project, and the old shared token acts as the first admin. A single user keeps working exactly as before. The Live, Query and System pages are admin-only. Existing data is migrated automatically. Design and rollout: `docs/access-control.md`. Invitations, the Users page, sharing and the audit log are described below.
- **Invitations and Users page.** Admins invite people with a one-time link (hashed, expiring, single use), optionally with a fixed username, a project limit and projects shared from the start; the same mechanism resets a password. The Users page lists accounts with what each owns and reaches, and can disable, enable, change role, set a limit or remove (a person who owns projects must hand them over first).
- **Sharing.** Each project has a Who has access panel: add by username, change roles, remove, leave, transfer ownership. Delete is for the owner only.
- **Token scopes and limits.** Tokens can be read-only and/or limited to chosen projects; each user can have a cap on how many projects they own.
- **Audit log.** Sign-ins, account changes, invitations, sharing, tokens, project changes and query-console use are recorded for 180 days (admin only, no secrets).
- A new project from a git remote is named after the repository, instead of `git-<hash>`.
- Fixed: a project you cannot see no longer resolves to its real id.
- `CAIRN_RESET_ADMIN` now removes every admin account and revokes the tokens they created (it used to remove only accounts with the old `Admin` label).

## [0.1.5] - 2026-10-18

- The `/cairn` slash command now shows errors instead of only "Background command failed".
- Docs: `cairn init <name> --create` for a new project, and how to replace an unnamed `git-…` project.
- The version shown in the dashboard and reported over MCP now comes from the package, instead of a hardcoded `0.1.0`.
- Projects can be deleted from the dashboard (project page → Delete, after typing its name). It removes the project, its memories, areas and registered git remotes.

## [0.1.4] - 2026-10-18

- `cairn init` no longer writes a project `.mcp.json` when the server is already registered with `claude mcp add --scope user` (it would shadow that entry and need environment variables); `--mcp-json` writes it anyway.

## [0.1.3] - 2026-10-18

- `cairn init`, `doctor` and the hooks use the address and token given to `claude mcp add`, so the one-line install is enough.
- A step-by-step install in the README and Claude Code guide, with troubleshooting.

## [0.1.2] - 2026-10-18

- The `agentcairn` README on npm now leads with the one-line install.

## [0.1.1] - 2026-10-18

- Published through npm trusted publishing (no stored token).

## [0.1.0] - 2026-10-18

First public version.

### Added

- **`cairn mcp`**: a stdio bridge so the install is one `claude mcp add ... -- npx -y agentcairn mcp` per machine, working in every folder (project from `.cairn.json` or the git remote).
- **`/cairn` slash command** for Claude Code (`cairn init` writes it for npx installs; `cairn install-command` installs it for every project), and a clearer error when a remote request names no project.
- **Memory model** in Neo4j: projects, areas and memories (overview, convention, gotcha, decision, checkpoint, thread, glossary) as a `Project → Area → Memory` tree, with `SUPERSEDES` history and automatic migration from earlier shapes.
- **MCP server** over HTTP (stateless Streamable HTTP) and a local stdio mode, with the tools `cairn_briefing`, `cairn_recall`, `cairn_remember`, `cairn_checkpoint`, `cairn_areas`, `cairn_forget` and `cairn_status`.
- **Token-budgeted briefings** with fixed section priorities, importance and recency ranking, and an onboarding prompt for empty projects.
- **Staleness detection** computed on the client from each memory's commit and paths.
- **Project identity** by explicit id or normalized, hashed git remote, including aliases for forks and mirrors.
- **Dashboard** at `/ui/`: live request feed with payload inspector, throughput and latency, projects and memories, an interactive graph with live pulses, a read-only Cypher console, access-token management, system information. Dark and light themes, responsive.
- **Accounts and tokens**: a one-time setup code printed in the server log creates the admin account; agent tokens are created and revoked in the dashboard and stored hashed.
- **`cairn` CLI** (`init`, `doctor`, `briefing`, `remote`, `hook`) and **Claude Code hooks** (briefing at session start, checkpoint reminder, commit and author stamping).
- **Docker image** for `linux/amd64` and `linux/arm64`, built and published by GitHub Actions, with Compose and Unraid template.
- MIT license, contributing guide, security policy and documentation.
