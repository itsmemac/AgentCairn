# @agentcairn/mcp-server

The server of [Agent Cairn](https://github.com/itsmemac/agentcairn): shared project memory for AI coding agents, stored in Neo4j.

It exposes:

- an **MCP endpoint** (`POST /mcp`, stateless Streamable HTTP) with the tools `cairn_briefing`, `cairn_recall`, `cairn_remember`, `cairn_checkpoint`, `cairn_areas`, `cairn_forget` and `cairn_status`;
- a **JSON API** (`/api/*`) used by the `cairn` CLI and Claude Code hooks;
- a **dashboard** at `/ui/`: live request feed, projects, memory graph, read-only Cypher console, token management;
- `GET /healthz` for container health checks.

## Run it

Most people run the Docker image (`ghcr.io/itsmemac/agentcairn`); see the [self-hosting guide](https://github.com/itsmemac/agentcairn/blob/main/docs/self-hosting.md). To run from source or npm:

```bash
NEO4J_URI=bolt://localhost:7687 NEO4J_PASSWORD=... npx -p @agentcairn/mcp-server cairn-mcp-http
```

The first start prints a one-time setup code in its log; open `http://localhost:8787/ui/` and use it to create the admin account.

There is also a local **stdio mode** (`cairn-mcp`) that talks to Neo4j directly and reads the working directory for the project, for single-machine use.

All settings are listed in [docs/configuration.md](https://github.com/itsmemac/agentcairn/blob/main/docs/configuration.md). MIT licensed.
