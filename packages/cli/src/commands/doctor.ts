import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkStaleness } from '@agentcairn/core'
import { ClientError, ServerClient, claudeRegistration, loadClientConfig } from '../client.js'
import { hasClaudeMdBlock, inspectHooks, inspectMcpConfig } from '../claude.js'
import { hintOf, readLocalProject } from '../project.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'
export interface Check {
  status: CheckStatus
  label: string
  fix?: string
}

const read = (file: string) => readFile(file, 'utf8').catch(() => null)

const ok = (label: string): Check => ({ status: 'ok', label })
const warn = (label: string, fix?: string): Check => ({ status: 'warn', label, fix })
const fail = (label: string, fix?: string): Check => ({ status: 'fail', label, fix })

export async function runDoctor(cwd: string): Promise<Check[]> {
  const checks: Check[] = []
  const local = await readLocalProject(cwd)

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  checks.push(
    major > 20 || (major === 20 && minor >= 12)
      ? ok(`Node ${process.versions.node}`)
      : fail(`Node ${process.versions.node} is too old`, 'Install Node 20.12 or newer.'),
  )

  let client: ServerClient
  try {
    const config = loadClientConfig(local.dir)
    client = new ServerClient(config, hintOf(local))
    checks.push(ok(`Server address: ${config.url}`))
    checks.push(
      config.token
        ? ok('Token is set')
        : warn('CAIRN_TOKEN is not set', 'Fine only if the server runs with CAIRN_NO_AUTH=1; otherwise set CAIRN_TOKEN.'),
    )
  } catch (error) {
    checks.push(fail((error as Error).message, 'Set CAIRN_URL (and CAIRN_TOKEN).'))
    return checks.concat(await claudeChecks(local))
  }

  for (const name of ['CAIRN_URL', 'CAIRN_TOKEN'] as const) {
    if (!process.env[name]) {
      checks.push(
        warn(
          `${name} is not in this process's environment`,
          `Claude Code reads it from the operating system environment, not from .env files. Set it there, then restart Claude Code.`,
        ),
      )
    }
  }

  try {
    await client.health()
    checks.push(ok('Server is up and can reach Neo4j'))
  } catch (error) {
    const message = error instanceof ClientError && error.status === 503 ? 'Server is up but cannot reach Neo4j' : (error as Error).message
    checks.push(fail(message, 'Check the container is running and NEO4J_URI in its .env.'))
    return checks.concat(await claudeChecks(local))
  }

  try {
    const info = await client.project()
    checks.push(ok(`Project "${info.projectId}" (via ${info.source === 'link' ? 'project id' : 'git remote'}), ${info.total} memories`))
    if (info.isNew) checks.push(warn('Project has no memories or registration yet', 'Run `cairn init`, or let the agent record the first memory.'))
    if (info.defaultCredentials) checks.push(warn('Neo4j is using the default credentials', 'Change the Neo4j password.'))
  } catch (error) {
    if (error instanceof ClientError && error.status === 401) checks.push(fail((error as Error).message, 'Set the same CAIRN_TOKEN the server uses.'))
    else if (error instanceof ClientError && error.code === 'unresolved_project') {
      checks.push(fail('This folder cannot be matched to a project', 'Run `cairn init <projectId>`.'))
    } else checks.push(fail((error as Error).message))
    return checks.concat(await claudeChecks(local))
  }

  try {
    const inputs = await client.staleInputs()
    const staleness = await checkStaleness(local.dir, inputs)
    const stale = [...staleness.values()].filter(s => s.status === 'stale').length
    checks.push(stale ? warn(`${stale} memories may be stale (files changed since they were written)`) : ok('No stale memories detected'))
  } catch {
    // staleness is a bonus; the checks above already reported connectivity
  }

  return checks.concat(await claudeChecks(local))
}

async function claudeChecks(local: Awaited<ReturnType<typeof readLocalProject>>): Promise<Check[]> {
  const checks: Check[] = []

  checks.push(
    local.projectId
      ? ok(`.cairn.json links to "${local.projectId}"`)
      : warn('No .cairn.json here', local.remote ? 'Fine: the git remote identifies the project. Run `cairn init` to register it.' : 'Run `cairn init <projectId>`.'),
  )

  const mcp = inspectMcpConfig(await read(join(local.dir, '.mcp.json')))
  if (!mcp.present) {
    checks.push(
      claudeRegistration().url
        ? ok('The cairn server is registered with Claude Code for every project')
        : warn('.mcp.json has no cairn server', 'Run `cairn init`, or register it once with `claude mcp add cairn --scope user ...`.'),
    )
  }
  else if (local.projectId && mcp.projectId && mcp.projectId !== local.projectId) {
    checks.push(fail(`.mcp.json uses project "${mcp.projectId}" but .cairn.json says "${local.projectId}"`, 'Run `cairn init` again to realign them.'))
  } else checks.push(ok('.mcp.json has the cairn server'))

  const hooks = inspectHooks(
    await read(join(local.dir, '.claude', 'settings.json')),
    await read(join(local.dir, '.claude', 'settings.local.json')),
  )
  const missing = [!hooks.sessionStart && 'session-start', !hooks.stop && 'stop', !hooks.preToolUse && 'pre-tool-use'].filter(Boolean)
  checks.push(missing.length ? warn(`Claude Code hooks missing: ${missing.join(', ')}`, 'Run `cairn init`.') : ok('Claude Code hooks installed'))
  if (!missing.length) {
    checks.push(hooks.capture ? ok('Session capture hooks installed') : warn('Session capture hooks missing: conversations are not being recorded for handoff', 'Run `cairn init` to add them.'))
  }

  checks.push(
    hasClaudeMdBlock(await read(join(local.dir, 'CLAUDE.md')))
      ? ok('CLAUDE.md has the Agent Cairn block')
      : warn('CLAUDE.md has no Agent Cairn block', 'Run `cairn init`.'),
  )
  return checks
}

export function formatChecks(checks: Check[]): string {
  const icon = { ok: '✓', warn: '!', fail: '✗' } as const
  return checks.map(c => `${icon[c.status]} ${c.label}${c.fix ? `\n    → ${c.fix}` : ''}`).join('\n')
}
