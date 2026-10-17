import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { writeLink } from '@agentcairn/core'
import { ClientError, ServerClient, loadClientConfig } from '../client.js'
import { mergeHooks, mergeMcpConfig, upsertClaudeMd } from '../claude.js'
import { installCommand } from './installCommand.js'
import { excludeLinkFile, hintOf, readLocalProject } from '../project.js'
import { cliCommand } from '../runner.js'

export interface InitFlags {
  create: boolean
  forceRemote: boolean
  personal: boolean
  noClaude: boolean
  local: boolean
}

const read = (file: string) => readFile(file, 'utf8').catch(() => null)

async function write(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

/**
 * `cairn init [projectId]`: registers the project with the server, writes
 * `.cairn.json`, and (unless --no-claude) wires Claude Code to the server.
 */
export async function runInit(projectIdArg: string | undefined, flags: InitFlags, cwd: string, out: (s: string) => void): Promise<void> {
  const local = await readLocalProject(cwd)
  const client = new ServerClient(loadClientConfig(local.dir), hintOf(local))
  const projectId = projectIdArg ?? local.projectId

  if (!projectId && !local.remote) {
    throw new ClientError(
      'This folder has no git remote to identify it. Pass a project id: cairn init <projectId>.',
      'unresolved_project',
    )
  }

  let allowCreate = flags.create
  const attempt = () => client.init({ projectId, remote: local.remote, allowCreate, forceRemote: flags.forceRemote })

  let result
  try {
    result = await attempt()
  } catch (error) {
    if (!(error instanceof ClientError) || error.code !== 'project_not_found') throw error
    const ok = await confirm(`Project "${projectId}" does not exist yet. Create it?`)
    if (!ok) {
      throw new ClientError(
        `Project "${projectId}" does not exist. Check the id, or pass --create to create it.`,
        'project_not_found',
      )
    }
    allowCreate = true
    result = await attempt()
  }
  if (!result) return

  await writeLink(local.dir, result.projectId)
  out(`${result.created ? 'Created' : 'Linked to'} project "${result.projectId}".`)
  out(`Wrote ${join(local.dir, '.cairn.json')}`)
  if (flags.personal) {
    out((await excludeLinkFile(local.dir)) ? '  (kept out of git via .git/info/exclude)' : '  (could not update .git/info/exclude)')
  } else {
    out('  Commit it to share the link with your team, or re-run with --personal to keep it out of git.')
  }
  if (!result.remoteAttached) out('  Note: no git remote, so other clones need `cairn init <projectId>` too.')

  if (flags.noClaude) return

  const identity = { projectId: result.projectId }
  const mcpFile = join(local.dir, '.mcp.json')
  await write(mcpFile, mergeMcpConfig(await read(mcpFile), identity))
  out(`Wrote ${mcpFile} (server entry; URL and token come from CAIRN_URL and CAIRN_TOKEN)`)

  const cli = cliCommand()
  const settingsFile = join(local.dir, '.claude', flags.local || cli.isMachineSpecific ? 'settings.local.json' : 'settings.json')
  await write(settingsFile, mergeHooks(await read(settingsFile), cli.command))
  out(`Wrote ${settingsFile} (hooks: briefing at session start, checkpoint reminder, commit stamping)`)
  if (cli.isMachineSpecific && !flags.local) {
    out('  This CLI runs from a source checkout, so the hooks went to settings.local.json (machine-specific, not for git).')
  }

  if (cli.isMachineSpecific) {
    out('  Skipped the /cairn slash command: this CLI runs from a source checkout. Run `cairn install-command` once to get it in every project.')
  } else {
    const command = await installCommand({ scope: 'project', dir: local.dir })
    out(command.written ? `Wrote ${command.file} (the /cairn slash command)` : `Left ${command.file} alone: it is not ours`)
  }

  const mdFile = join(local.dir, 'CLAUDE.md')
  await write(mdFile, upsertClaudeMd(await read(mdFile)))
  out(`Updated ${mdFile}`)

  out('')
  out('Next: make sure CAIRN_URL and CAIRN_TOKEN are set in the environment Claude Code runs in,')
  out('then restart Claude Code here and approve the "cairn" server. Run `cairn doctor` to verify.')
}
