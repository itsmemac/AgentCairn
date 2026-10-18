# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project aims to follow [Semantic Versioning](https://semver.org/) once it reaches 1.0.

## [Unreleased]

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
