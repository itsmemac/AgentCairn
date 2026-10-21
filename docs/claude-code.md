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

1. **An explicit project**: the `X-Cairn-Project` header (from `.mcp.json`) or `.cairn.json`. It holds a project **id** (`prj_…`, generated when the project is created). A project **name** also works, among the projects you can access. Works even when git remotes differ (forks, mirrors, renamed repositories).
2. **The git remote**, normalized (`git@github.com:Acme/App.git` and `https://github.com/acme/app` are the same) and stored only as a hash, never as a URL. Credentials in a remote are dropped before anything leaves your machine. It matches among **your own projects**: two people in one repository each get their own project unless one shares theirs.
3. Otherwise a new project, owned by you and **named after the repository**, is created from the remote on first write.

An explicit name or id is never created implicitly (a typo would start an empty project); create it in the dashboard or with `cairn init <name> --create`. Projects are private to their owner; see [Users, projects and access control](access-control.md).

## Handing work over

The point of the tool is that another agent, on another machine or account, can pick up exactly where the last one stopped, without you explaining it all again, and even if the first machine is gone. Two things make that work.

**Recorded automatically (the hooks, no effort from the agent).** As a session goes, the hooks keep a snapshot of it on the server: what you asked (the first request and the most recent ones), the agent's last message, the files it edited, the commits it made, the branch and commit it was on, and which files were still uncommitted. It is updated on every prompt, every turn, before the context is compacted and when the session ends, so what exists is whatever happened up to the last turn, even if the laptop dies mid-session.

**Written by the agent (`cairn_handoff`).** The part only the agent that did the work can write: what is done, what is in progress and its exact state, what to do next in order, what is blocked or still a question, the assumptions it is working under (what it takes as given that the code does not show), what was tried and dropped (so nobody repeats it), and what you asked that must keep being honoured. It replaces the previous handoff for the same topic (the branch by default), and the older ones are kept as history. The Stop hook asks for one when work was done but nothing was recorded.

**Picking up.** A new session starts with a briefing that opens with **Where we left off** (the handoff) and **Recent sessions**, then a **Check before you continue** section, computed on your machine:

- the last handoff was written at a commit this clone does not have, so it may never have been pushed;
- how many commits have been made since;
- the handoff is for another branch;
- the previous session, on another machine, left uncommitted files that exist only there.

`cairn_resume` (and `cairn resume` on the command line) gives the whole picture without a token budget: every handoff in full, each recent session in detail, the open threads, and the exact git commands to check the repository against where the work stopped.

**What is stored, and your control over it.** Prompts and replies are run through a secret filter on your machine before they are sent (tokens, keys, passwords stated in a sentence, `user:pass@` in URLs, private keys) and again on the server, and are kept to a few hundred characters. It is best-effort, so it can miss things. Set `CAIRN_SESSION_CAPTURE` to `meta` to send only files, commits and repository state and never any words, or to `off` to send nothing. A session is only recorded for a folder that is already linked to a project: capture never creates one.

## The hooks

The server cannot see your repository, so anything that depends on it happens on your machine:

| Hook | What it does |
| --- | --- |
| **SessionStart** | Computes which memories are stale (the files they concern changed since they were written), injects the briefing into the new session, and adds the repository check. |
| **UserPromptSubmit** | Records the prompt and the state of the session as it is sent. |
| **Stop** | Records the session after every turn. After a turn with several file edits and no `cairn_handoff` or `cairn_checkpoint`, asks the agent to write one before finishing. |
| **PreCompact** | Records the session before the context is compacted. |
| **SessionEnd** | Marks the end of the session. |
| **PreToolUse** | Adds the current commit and git author to `cairn_remember`, `cairn_checkpoint` and `cairn_handoff`, adds the branch, commit and uncommitted files to `cairn_handoff` and `cairn_resume`, and approves those calls without a prompt. |

Hooks never block a session: if the server is unreachable they stay silent. You can tune them with environment variables:

| Variable | Default | Effect |
| --- | --- | --- |
| `CAIRN_BRIEFING_TOKENS` | `1200` | Token budget of the briefing injected at session start |
| `CAIRN_CHECKPOINT_MIN_EDITS` | `3` | File edits in a turn before the Stop hook asks for a checkpoint |
| `CAIRN_HOOK_TIMEOUT_MS` | `10000` | How long a hook waits for the server |
| `CAIRN_SESSION_CAPTURE` | `full` | `full`, `meta` (files, commits and repository state only) or `off` |
| `CAIRN_CAPTURE_TIMEOUT_MS` | `3000` | How long the capture hooks wait, so a slow server never holds up a prompt |

## Troubleshooting

Run `cairn doctor` first. It reports the server address, token, connectivity, project resolution, and whether the files and hooks are in place.

- **"MCP server cairn already exists in user config".** Run `claude mcp remove cairn --scope user`, then add it again. It does not appear in the Claude desktop app's "MCP servers" dialog: that dialog lists only the desktop app's own servers, while `claude mcp add` writes to the Claude Code CLI config. Use `claude mcp list` and `claude mcp get cairn` to see it, and `claude mcp get` also names the scope if it is not `user`.
- **`claude mcp list` shows `cairn` as failed.** Run the bridge by hand to see why: `npx -y agentcairn mcp` (it waits for input; press Ctrl+C). Typical causes: Node older than 20, the server address is not reachable from this computer (try `curl <address>/healthz`), or a wrong token (`401`).
- **The `cairn` server shows as failed or unauthorized in Claude Code.** `CAIRN_URL` or `CAIRN_TOKEN` is missing from the environment Claude Code started in. Set them and restart the app.
- **`401`**: the token is wrong or revoked; create a new one under **Access**.
- **Two projects have the same name.** Names may repeat; ids may not. Use the id (shown on the project page, and in `.cairn.json`) when a name is ambiguous.
- **"Project … does not exist yet"**: create it under **Projects → New project**, or run `cairn init <id> --create`.
- **The agent never uses Agent Cairn.** Install the hooks and `CLAUDE.md` block with `cairn init`, or add the instructions yourself.
- **Memories show no commit or author.** The PreToolUse hook is not installed or not running; check `cairn doctor`.
