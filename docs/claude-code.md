# Using Agent Cairn with Claude Code

Claude Code talks to the server over MCP. There are a few ways to connect, from least to most setup. All of them need a token from the dashboard (**Access → Create token**).

## Option 0: one command, every project (recommended)

**Before you start:** [Claude Code](https://claude.com/claude-code), Node.js 20.12 or newer (it provides `npx`), a reachable Agent Cairn server, and a token for this computer (dashboard → **Access → Create token**; one per computer is cleanest).

**1. Add it, once per machine.** The **Access** page generates this command with your address and token filled in.

```bash
claude mcp add cairn --scope user -e CAIRN_URL=http://localhost:8787 -e CAIRN_TOKEN=<token> -- npx -y agentcairn mcp
```

It is one line on purpose, so it pastes the same into PowerShell, cmd, bash and zsh.

**2. Check it.**

```bash
claude mcp list          # cairn: ✓ Connected
claude mcp get cairn     # scope, command and environment
```

Restart Claude Code (or start a new session), then ask the agent to call `cairn_status`.

`cairn mcp` is a small stdio bridge to your server. It reads the project from the folder Claude Code was started in: `.cairn.json` if there is one, otherwise the git remote. A new repository therefore gets its own memory with no setup. Use `cairn init <project-id>` (Option 3) when a folder has no git remote, or when forks and mirrors should share one project.

**Change the address or token, or reinstall.** `claude mcp add` refuses to overwrite, and prints `MCP server cairn already exists in user config`. Remove it first, then add it again:

```bash
claude mcp remove cairn --scope user
```

**Update.** `npx -y agentcairn` fetches the latest release the next time Claude Code starts the server, so there is nothing to do. To pin a version, use `agentcairn@0.1.2` in the command.

**Uninstall.** `claude mcp remove cairn --scope user`. If you also ran `cairn install-command`, delete `~/.claude/commands/cairn.md`.

The bridge needs Node 20+. Without Node, use Option 1.

## Option 1: direct HTTP, no Node

Run this inside the project folder.

```bash
claude mcp add --transport http cairn http://localhost:8787/mcp \
  --header "Authorization: Bearer <token>" \
  --header "X-Cairn-Project: <project-id>"
```

The `X-Cairn-Project` header tells the server which brain to use. The agent can now call the seven tools (`cairn_briefing`, `cairn_recall`, `cairn_remember`, `cairn_checkpoint`, `cairn_areas`, `cairn_forget`, `cairn_status`). Without hooks it only uses them when it decides to, so add a line to your `CLAUDE.md` telling it to start with `cairn_briefing` and to call `cairn_checkpoint` after finishing a goal (Option 3 does this for you).

## Option 2: a committed `.mcp.json`

Commit this at the repository root so every contributor gets the server automatically:

```json
{
  "mcpServers": {
    "cairn": {
      "type": "http",
      "url": "${CAIRN_URL}/mcp",
      "headers": {
        "Authorization": "Bearer ${CAIRN_TOKEN}",
        "X-Cairn-Project": "my-project"
      }
    }
  }
}
```

The address and token come from each person's environment, so no secret is committed. Set `CAIRN_URL` (for example `http://localhost:8787`, no trailing slash) and `CAIRN_TOKEN` **in the operating system environment where Claude Code runs**. Claude Code does not read `.env` files for this. On Windows, `setx` only affects programs started afterwards, so fully quit and reopen the app; on macOS and Linux, export them in your shell profile (or the desktop session for GUI apps).

## Option 3: the `cairn` CLI (adds hooks)

The CLI does Option 2 for you and also installs hooks and a `CLAUDE.md` block, so the agent uses Agent Cairn without being asked.

```bash
export CAIRN_URL=http://localhost:8787
export CAIRN_TOKEN=<token>

cairn init               # identify the project by its git remote
cairn init my-project --create    # or by an explicit id (--create the first time)
cairn doctor             # check the whole setup
```

> The CLI is on npm as [`agentcairn`](https://www.npmjs.com/package/agentcairn). Use `npx -y agentcairn <command>` in place of `cairn`, or `npm install -g agentcairn` to get the `cairn` command. To run from a source checkout instead, build it (`npm install && npm run build`) and use `node packages/cli/dist/bin.js`.

`cairn init` writes, in the project folder:

| File | Purpose | Commit it? |
| --- | --- | --- |
| `.cairn.json` | Links the folder to a project id | Yes (or use `--personal` to keep it out of git) |
| `.mcp.json` | The server entry from Option 2. Skipped when you already ran the one-line install (Option 0), because a project entry would shadow it; pass `--mcp-json` to write it anyway | Yes |
| `.claude/settings.json` | The three hooks below | Yes |
| `.claude/settings.local.json` | The hooks, when the CLI runs from a source checkout (the command contains a machine-specific path) | No |
| `CLAUDE.md` | A short marked block telling the agent how to use Agent Cairn | Yes |

Re-running `cairn init` is safe: it merges into existing files and changes nothing that is already right. `cairn init <id>` refuses an unknown id unless you pass `--create`, so a typo cannot silently start an empty brain.

### Commands

Inside Claude Code, the same commands are available as `/cairn <command>` (for example `/cairn init my-project --create` the first time you name a project). `cairn init` writes `.claude/commands/cairn.md` when the CLI is run through `npx`; from a source checkout, run `cairn install-command` once to install it for all projects.

| Command | What it does |
| --- | --- |
| `cairn init [projectId]` | Register the project, write the files above (`--create`, `--personal`, `--local`, `--force-remote`, `--no-claude`) |
| `cairn doctor` | Check Node, server, token, Neo4j, project, hooks, `.mcp.json`, `CLAUDE.md` |
| `cairn briefing [--tokens N]` | Print the briefing an agent would receive |
| `cairn remote <git-url>` | Make another git URL resolve to this project |
| `cairn install-command [--project]` | Add the `/cairn` slash command to Claude Code for every project (or just this one) |
| `cairn hook <name>` | Used by the hooks; not for direct use |

## How a project is identified

In this order:

1. **An explicit project id**: the `X-Cairn-Project` header (from `.mcp.json`) or `.cairn.json`. Works even when git remotes differ (forks, mirrors, renamed repositories).
2. **The git remote**, normalized (`git@github.com:Acme/App.git` and `https://github.com/acme/app` are the same) and stored only as a hash, never as a URL. Credentials in a remote are dropped before anything leaves your machine.
3. Otherwise a new `git-<hash>` project is created from the remote on first write.

An explicit id is never created implicitly (a typo would start an empty brain); create it in the dashboard or with `cairn init <id> --create`.

## The hooks

The server cannot see your repository, so anything that depends on it happens on your machine:

| Hook | What it does |
| --- | --- |
| **SessionStart** | Computes which memories are stale (the files they concern changed since they were written) and injects the briefing into the new session. |
| **Stop** | After a turn with several file edits and no `cairn_checkpoint`, asks the agent to record a checkpoint before finishing. |
| **PreToolUse** | Adds the current commit and git author to `cairn_remember` and `cairn_checkpoint` calls, and approves those two calls without a prompt. |

Hooks never block a session: if the server is unreachable they stay silent. You can tune them with environment variables:

| Variable | Default | Effect |
| --- | --- | --- |
| `CAIRN_BRIEFING_TOKENS` | `1200` | Token budget of the briefing injected at session start |
| `CAIRN_CHECKPOINT_MIN_EDITS` | `3` | File edits in a turn before the Stop hook asks for a checkpoint |
| `CAIRN_HOOK_TIMEOUT_MS` | `10000` | How long a hook waits for the server |

## Troubleshooting

Run `cairn doctor` first. It reports the server address, token, connectivity, project resolution, and whether the files and hooks are in place.

- **"MCP server cairn already exists in user config".** Run `claude mcp remove cairn --scope user`, then add it again. It does not appear in the Claude desktop app's "MCP servers" dialog: that dialog lists only the desktop app's own servers, while `claude mcp add` writes to the Claude Code CLI config. Use `claude mcp list` and `claude mcp get cairn` to see it, and `claude mcp get` also names the scope if it is not `user`.
- **`claude mcp list` shows `cairn` as failed.** Run the bridge by hand to see why: `npx -y agentcairn mcp` (it waits for input; press Ctrl+C). Typical causes: Node older than 20, the server address is not reachable from this computer (try `curl <address>/healthz`), or a wrong token (`401`).
- **The `cairn` server shows as failed or unauthorized in Claude Code.** `CAIRN_URL` or `CAIRN_TOKEN` is missing from the environment Claude Code started in. Set them and restart the app.
- **`401`**: the token is wrong or revoked; create a new one under **Access**.
- **A project named `git-<letters and digits>` appeared.** `cairn init` with no id names the project after the git remote. To give the repository a real name instead, run `cairn init <name> --create --force-remote` (it moves the remote to the new project), then delete the empty `git-…` project from its page in the dashboard.
- **"Project … does not exist yet"**: create it under **Projects → New project**, or run `cairn init <id> --create`.
- **The agent never uses Agent Cairn.** Install the hooks and `CLAUDE.md` block with `cairn init`, or add the instructions yourself.
- **Memories show no commit or author.** The PreToolUse hook is not installed or not running; check `cairn doctor`.
