# agentcairn

The command line for [Agent Cairn](https://github.com/itsmemac/agentcairn): shared, persistent project memory for AI coding agents, stored in Neo4j.

## Connect Claude Code (one command, every project)

You need a running Agent Cairn server and a token from its dashboard (**Access → Create token**). Then, once per machine:

```bash
claude mcp add cairn --scope user -e CAIRN_URL=http://localhost:8787 -e CAIRN_TOKEN=<token> -- npx -y agentcairn mcp
```

Check it with `claude mcp list` (it should say Connected), then restart Claude Code. If it says "MCP server cairn already exists in user config", run `claude mcp remove cairn --scope user` and add it again.

`agentcairn mcp` is a small bridge to your server. It takes the project from the folder Claude Code was started in (its `.cairn.json`, else the git remote), so there is nothing to configure per repository.

## Commands

```bash
npx -y agentcairn <command>     # or: npm install -g agentcairn, then use `cairn`

cairn init [project-id]    # link this folder to a project; add hooks and a CLAUDE.md block
cairn doctor               # check the whole setup
cairn briefing             # print what an agent would be told
cairn resume               # everything needed to carry on where the last agent stopped
cairn remote <git-url>     # make another git URL resolve to this project
cairn install-command      # add the /cairn slash command to Claude Code
cairn mcp                  # the stdio bridge used above
```

`cairn init` writes `.cairn.json`, a `.mcp.json` server entry (only when the server is not already registered for every project; no secrets, the address and token come from your environment), Claude Code hooks and a short `CLAUDE.md` block. The hooks inject the briefing at session start (opening with where the last work stopped), record the session as it goes (what was asked, files, commits, uncommitted work; set `CAIRN_SESSION_CAPTURE=meta` or `off` to send less), remind the agent to write a handoff after substantial work, and stamp memories with the commit and author. Set `CAIRN_URL` and `CAIRN_TOKEN` in your environment for the hooks to reach the server.

Everything here runs on your machine, because the server cannot see your repository. See [Using it with Claude Code](https://github.com/itsmemac/agentcairn/blob/main/docs/claude-code.md). MIT licensed.
