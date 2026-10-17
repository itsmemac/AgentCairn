# agentcairn

The `cairn` command for [Agent Cairn](https://github.com/itsmemac/agentcairn): link a project folder to a shared memory and wire it into Claude Code.

```bash
export CAIRN_URL=http://localhost:8787     # your Agent Cairn server
export CAIRN_TOKEN=<token from the dashboard>

cairn init               # identify the project by its git remote
cairn init my-project    # or by an explicit id
cairn doctor             # check the whole setup
cairn briefing           # print what an agent would be told
cairn remote <git-url>   # make another git URL resolve to this project
```

`cairn init` writes `.cairn.json`, a `.mcp.json` server entry (no secrets: the address and token come from your environment), Claude Code hooks, and a short `CLAUDE.md` block. The hooks inject the briefing at session start, remind the agent to checkpoint after substantial work, and stamp memories with the commit and author.

Everything here runs on your machine, because the server cannot see your repository. See [Using it with Claude Code](https://github.com/itsmemac/agentcairn/blob/main/docs/claude-code.md). MIT licensed.
