#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { checkStaleness, getWorkspace } from '@agentcairn/core'
import { ClientError, ServerClient, loadClientConfig } from './client.js'
import { formatChecks, runDoctor } from './commands/doctor.js'
import { runHook } from './commands/hook.js'
import { runInit } from './commands/init.js'
import { installCommand } from './commands/installCommand.js'
import { runMcpProxy } from './commands/mcpProxy.js'
import { hintOf, readLocalProject } from './project.js'
import { cliVersion } from './version.js'

const HELP = `cairn: shared project memory for AI agents

Usage:
  cairn init [projectId]   Link this folder to a project and wire up Claude Code
      --create             Create the project if it does not exist (no prompt)
      --force-remote       Move this git remote from another project to this one
      --personal           Keep .cairn.json out of git (via .git/info/exclude)
      --local              Put hooks in .claude/settings.local.json
      --mcp-json           Write .mcp.json even if the server is already registered for every project
      --no-claude          Only link the folder; skip .mcp.json, hooks and CLAUDE.md
  cairn doctor             Check the setup end to end
  cairn --version          Print the CLI version
  cairn briefing           Print the briefing an agent would get
      --tokens <n>         Token budget (default 1200)
  cairn resume             Everything needed to carry on where the last agent stopped
  cairn remote <git-url>   Also recognize another git URL as this project
      --force              Take the URL over from another project
  cairn mcp                Run as a stdio MCP server that forwards to your Agent Cairn server
  cairn install-command    Add the /cairn slash command to Claude Code for every project
      --project            Only for this project (.claude/commands)
  cairn hook <name>        Used by Claude Code hooks (session-start, stop, pre-tool-use)

Environment: CAIRN_URL (server address), CAIRN_TOKEN (bearer token).
CAIRN_SESSION_CAPTURE: full (default), meta (files and commits only) or off.
Also read from CAIRN_ENV_FILE, ./.env or ~/.cairn/.env.`

const print = (s: string) => console.log(s)

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  const cwd = process.cwd()

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      print(HELP)
      return command === undefined ? 1 : 0

    case '--version':
    case '-v':
    case 'version':
      print(cliVersion())
      return 0

    case 'init': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          create: { type: 'boolean', default: false },
          'force-remote': { type: 'boolean', default: false },
          personal: { type: 'boolean', default: false },
          local: { type: 'boolean', default: false },
          'no-claude': { type: 'boolean', default: false },
          'mcp-json': { type: 'boolean', default: false },
        },
      })
      await runInit(positionals[0], {
        create: values.create,
        forceRemote: values['force-remote'],
        personal: values.personal,
        local: values.local,
        noClaude: values['no-claude'],
        mcpJson: values['mcp-json'],
      }, cwd, print)
      return 0
    }

    case 'doctor': {
      const checks = await runDoctor(cwd)
      print(formatChecks(checks))
      return checks.some(c => c.status === 'fail') ? 1 : 0
    }

    case 'briefing': {
      const { values } = parseArgs({ args: rest, options: { tokens: { type: 'string' } } })
      const local = await readLocalProject(cwd)
      const client = new ServerClient(loadClientConfig(local.dir), hintOf(local))
      const staleness = await checkStaleness(local.dir, await client.staleInputs())
      const stale = [...staleness].filter(([, s]) => s.status === 'stale').map(([id, s]) => ({ id, changedPaths: s.changedPaths }))
      print((await client.briefing({ maxTokens: values.tokens ? Number(values.tokens) : 1200, stale })).text)
      return 0
    }

    case 'resume': {
      const local = await readLocalProject(cwd)
      const client = new ServerClient(loadClientConfig(local.dir), hintOf(local))
      const here = await getWorkspace(local.dir)
      const reply = await client.resume({ workspace: { branch: here.branch ?? undefined, head: here.head ?? undefined, dirty: here.dirty } })
      print(reply.text)
      return 0
    }

    case 'remote': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { force: { type: 'boolean', default: false } } })
      const url = positionals[0]
      if (!url) throw new ClientError('Usage: cairn remote <git-url>', 'usage')
      const local = await readLocalProject(cwd)
      const client = new ServerClient(loadClientConfig(local.dir), hintOf(local))
      const r = await client.addRemote(url, values.force)
      print(`Project "${r.projectId}" now also answers to ${r.remote}.`)
      return 0
    }

    case 'mcp':
      await runMcpProxy(cwd)
      return 0

    case 'install-command': {
      const { values } = parseArgs({ args: rest, options: { project: { type: 'boolean', default: false } } })
      const local = await readLocalProject(cwd)
      const r = await installCommand({ scope: values.project ? 'project' : 'global', dir: local.dir })
      print(r.written ? `Installed ${r.file}\nIn Claude Code, \`/cairn init <project-id>\` and \`/cairn doctor\` now work.` : `${r.file} exists and is not ours; left alone.`)
      return 0
    }

    case 'hook':
      await runHook(rest[0] ?? '')
      return 0

    default:
      console.error(`Unknown command "${command}". Run \`cairn help\`.`)
      return 1
  }
}

// Set the exit code and let the event loop drain: calling process.exit() while
// sockets are closing can crash Node on Windows. The unref'd timer is only a
// backstop for a connection that refuses to close.
const finish = (code: number) => {
  process.exitCode = code
  setTimeout(() => process.exit(code), 2000).unref()
}

main().then(finish, error => {
  console.error(`cairn: ${error instanceof Error ? error.message : String(error)}`)
  finish(1)
})
