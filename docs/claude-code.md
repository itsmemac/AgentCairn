# Using Agent Cairn with Claude Code

Claude Code talks to the server over MCP. There are a few ways to connect, from least to most setup. All of them need a token from the dashboard (**Access → Create token**).

## Option 0: one command, every project (recommended)

Run this once per machine. The **Access** page generates it with your server address and token filled in.

```bash
claude mcp add cairn --scope user -e CAIRN_URL=http://localhost:8787 -e CAIRN_TOKEN=<token> -- npx -y agentcairn mcp
```

`cairn mcp` is a small stdio bridge to your server. It reads the project from the folder Claude Code was started in: `.cairn.json` if there is one, otherwise the git remote. A new repository therefore gets its own brain with no setup. Use `cairn init <project-id>` (Option 3) when a folder has no git remote, or when forks and mirrors should share one project.

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

## Option 3: the `cairn` CLI (recommended)

The CLI does Option 2 for you and also installs hooks and a `CLAUDE.md` block, so the agent uses Agent Cairn without being asked.

```bash
export CAIRN_URL=http://localhost:8787
export CAIRN_TOKEN=<token>

cairn init               # identify the project by its git remote
cairn init my-project    # or by an explicit id
cairn doctor             # check the whole setup
```

> The npm packages are not published yet. Build the CLI from source (`npm install && npm run build` in a clone of this repository) and run `node packages/cli/dist/bin.js` in place of `brain`.

`cairn init` writes, in the project folder:

| File | Purpose | Commit it? |
| --- | --- | --- |
| `.cairn.json` | Links the folder to a project id | Yes (or use `--personal` to keep it out of git) |
| `.mcp.json` | The server entry from Option 2 | Yes |
| `.claude/settings.json` | The three hooks below | Yes |
| `.claude/settings.local.json` | The hooks, when the CLI runs from a source checkout (the command contains a machine-specific path) | No |
| `CLAUDE.md` | A short marked block telling the agent how to use Agent Cairn | Yes |

Re-running `cairn init` is safe: it merges into existing files and changes nothing that is already right. `cairn init <id>` refuses an unknown id unless you pass `--create`, so a typo cannot silently start an empty brain.

### Commands

Inside Claude Code, the same commands are available as `/cairn <command>` (for example `/cairn init my-project`). `cairn init` writes `.claude/commands/cairn.md` when the CLI is run through `npx`; from a source checkout, run `cairn install-command` once to install it for all projects.

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

- **The `cairn` server shows as failed or unauthorized in Claude Code.** `CAIRN_URL` or `CAIRN_TOKEN` is missing from the environment Claude Code started in. Set them and restart the app.
- **`401`**: the token is wrong or revoked; create a new one under **Access**.
- **"Project … does not exist yet"**: create it under **Projects → New project**, or run `cairn init <id> --create`.
- **The agent never uses Agent Cairn.** Install the hooks and `CLAUDE.md` block with `cairn init`, or add the instructions yourself.
- **Memories show no commit or author.** The PreToolUse hook is not installed or not running; check `cairn doctor`.
