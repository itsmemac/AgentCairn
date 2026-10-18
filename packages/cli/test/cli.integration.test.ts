import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type Brain,
  loadConfig,
  normalizeRemoteUrl,
  openBrain,
  remember,
  remoteHash,
} from '@agentcairn/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const bin = join(root, 'packages/cli/dist/bin.js')
const serve = join(root, 'packages/mcp-server/dist/serve.js')

describe.skipIf(!process.env.NEO4J_URI)('brain CLI against a real server and Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const token = `tok-${randomBytes(8).toString('hex')}`
  const port = 20000 + Math.floor(Math.random() * 20000)
  const url = `http://127.0.0.1:${port}`
  const remoteA = `https://example.com/${run}/app.git`
  const idA = `git-${remoteHash(normalizeRemoteUrl(remoteA)!)}`
  const named = `${run}-named`
  const dirs: string[] = []
  const emptyHome = mkdtempSync(join(tmpdir(), 'cairn-home-'))
  dirs.push(emptyHome)
  let brain: Brain
  let server: ChildProcess

  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    CAIRN_URL: url,
    CAIRN_TOKEN: token,
    CAIRN_HOOK_TIMEOUT_MS: '4000',
    // an empty home, so the developer's own Claude Code registration cannot change what init writes
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    ...extra,
  }) as NodeJS.ProcessEnv

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=m@m', ...args], { cwd, encoding: 'utf8' }).trim()

  const repo = (remote: string) => {
    const d = mkdtempSync(join(tmpdir(), 'cairn-cli-'))
    dirs.push(d)
    git(d, 'init', '-q')
    git(d, 'config', 'user.name', 'Test User')
    git(d, 'remote', 'add', 'origin', remote)
    writeFileSync(join(d, 'app.ts'), '1')
    git(d, 'add', '-A')
    git(d, 'commit', '-qm', 'init')
    return d
  }

  const brainCli = (cwd: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}) => {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd, env: opts.env ?? env(), input: opts.input ?? '', encoding: 'utf8', timeout: 30000 })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }

  beforeAll(async () => {
    expect(existsSync(bin) && existsSync(serve)).toBe(true)
    brain = openBrain(loadConfig())
    server = spawn(process.execPath, [serve], {
      env: { ...process.env, CAIRN_TOKEN: token, CAIRN_PORT: String(port), CAIRN_HOST: '127.0.0.1' },
      stdio: 'ignore',
    })
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${url}/healthz`)).ok) return
      } catch {
        // not up yet
      }
      await new Promise(r => setTimeout(r, 250))
    }
    throw new Error('server did not start')
  })

  afterAll(async () => {
    server.kill()
    const ids = [idA, named]
    await brain.run('MATCH (n) WHERE n.projectId IN $ids DETACH DELETE n', { ids })
    await brain.run('MATCH (p:Project) WHERE p.id IN $ids DETACH DELETE p', { ids })
    await brain.run('MATCH (r:Remote) WHERE NOT (r)-[:BELONGS_TO]->() DETACH DELETE r')
    await brain.close()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('a server with no static token still starts, but refuses every request until a dashboard token is presented', async () => {
    const lonePort = port + 1
    const lone = spawn(process.execPath, [serve], {
      env: { ...process.env, CAIRN_TOKEN: '', CAIRN_NO_AUTH: '', CAIRN_PORT: String(lonePort), CAIRN_HOST: '127.0.0.1' },
      stdio: 'ignore',
    })
    try {
      let up = false
      for (let i = 0; i < 60 && !up; i++) {
        up = await fetch(`http://127.0.0.1:${lonePort}/healthz`).then(r => r.ok, () => false)
        if (!up) await new Promise(r => setTimeout(r, 250))
      }
      expect(up).toBe(true)
      const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer nope' }]
      for (const headers of attempts) {
        const r = await fetch(`http://127.0.0.1:${lonePort}/api/project`, { headers: { ...headers, 'x-cairn-project': 'x' } })
        expect(r.status).toBe(401)
      }
      expect((await fetch(`http://127.0.0.1:${lonePort}/ui/`)).status).toBe(200)
    } finally {
      lone.kill()
    }
  })

  let a: string

  it('init registers by git remote and writes link, MCP entry, hooks and CLAUDE.md', () => {
    a = repo(remoteA)
    const r = brainCli(a, ['init'])
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Created project "${idA}"`)

    expect(JSON.parse(readFileSync(join(a, '.cairn.json'), 'utf8'))).toEqual({ projectId: idA })
    const mcp = JSON.parse(readFileSync(join(a, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers['cairn']).toEqual({
      type: 'http',
      url: '${CAIRN_URL}/mcp',
      headers: { Authorization: 'Bearer ${CAIRN_TOKEN}', 'X-Cairn-Project': idA },
    })
    expect(readFileSync(join(a, '.mcp.json'), 'utf8')).not.toContain(token)
    const settings = JSON.parse(readFileSync(join(a, '.claude', 'settings.local.json'), 'utf8'))
    expect(Object.keys(settings.hooks).sort()).toEqual(['PreToolUse', 'SessionStart', 'Stop'])
    expect(readFileSync(join(a, 'CLAUDE.md'), 'utf8')).toContain('cairn_checkpoint')
  })

  it('init skips .mcp.json when the server is registered for every project, unless asked', () => {
    const home = mkdtempSync(join(tmpdir(), 'cairn-home-'))
    dirs.push(home)
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { cairn: { type: 'stdio', env: { CAIRN_URL: url, CAIRN_TOKEN: token } } } }))
    const withHome = env({ HOME: home, USERPROFILE: home })

    const skipped = repo(`https://example.com/${run}/registered.git`)
    const r = brainCli(skipped, ['init'], { env: withHome })
    expect(r.code).toBe(0)
    expect(r.out).toContain('Skipped .mcp.json')
    expect(existsSync(join(skipped, '.mcp.json'))).toBe(false)
    expect(existsSync(join(skipped, '.cairn.json'))).toBe(true)

    const forced = repo(`https://example.com/${run}/forced.git`)
    expect(brainCli(forced, ['init', '--mcp-json'], { env: withHome }).code).toBe(0)
    expect(existsSync(join(forced, '.mcp.json'))).toBe(true)
  })

  it('init is idempotent', () => {
    const files = ['.cairn.json', '.mcp.json', '.claude/settings.local.json', 'CLAUDE.md']
    const before = files.map(f => readFileSync(join(a, f), 'utf8'))
    const r = brainCli(a, ['init'])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Linked to project "${idA}"`)
    expect(files.map(f => readFileSync(join(a, f), 'utf8'))).toEqual(before)
  })

  it('init <projectId> refuses an unknown id without --create, then links a differently-hosted clone', () => {
    const b = repo(`https://example.com/${run}/fork.git`)
    const refused = brainCli(b, ['init', named])
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('--create')
    expect(existsSync(join(b, '.cairn.json'))).toBe(false)

    expect(brainCli(b, ['init', named, '--create', '--no-claude']).code).toBe(0)
    expect(existsSync(join(b, '.mcp.json'))).toBe(false)

    const c = repo(`git@example.org:someone/mirror-${run}.git`)
    const linked = brainCli(c, ['init', named, '--personal'])
    expect(linked.code).toBe(0)
    expect(linked.out).toContain(`Linked to project "${named}"`)
    expect(readFileSync(join(c, '.git', 'info', 'exclude'), 'utf8')).toContain('.cairn.json')
    expect(git(c, 'status', '--porcelain')).not.toContain('.cairn.json')
  })

  it('init reports a remote that belongs to another project, and --force-remote moves it', () => {
    const d = repo(remoteA)
    const conflict = brainCli(d, ['init', named])
    expect(conflict.code).toBe(1)
    expect(conflict.err).toContain(idA)
    expect(brainCli(d, ['init', named, '--force-remote', '--no-claude']).code).toBe(0)

    // the remote now belongs to `named`, so the original project is the one in conflict
    const back = brainCli(repo(remoteA), ['init', idA, '--no-claude'])
    expect(back.code).toBe(1)
    expect(back.err).toContain(named)
    expect(brainCli(repo(remoteA), ['init', idA, '--force-remote', '--no-claude']).code).toBe(0)
  })

  it('doctor passes on a configured folder and fails on a wrong token', () => {
    const good = brainCli(a, ['doctor'])
    expect(good.out).toContain('✓ Server is up and can reach Neo4j')
    expect(good.out).toContain('✓ Claude Code hooks installed')
    expect(good.out).toContain('✓ CLAUDE.md has the Agent Cairn block')
    expect(good.code).toBe(0)

    const bad = brainCli(a, ['doctor'], { env: env({ CAIRN_TOKEN: 'nope' }) })
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('✗ The server rejected the token')

    const down = brainCli(a, ['doctor'], { env: env({ CAIRN_URL: 'http://127.0.0.1:1' }) })
    expect(down.code).toBe(1)
    expect(down.out).toContain('Cannot reach the Agent Cairn server')

    const noUrl = brainCli(a, ['doctor'], { env: env({ CAIRN_URL: '', CAIRN_ENV_FILE: join(tmpdir(), 'does-not-exist.env') }) })
    expect(noUrl.out).toContain('CAIRN_URL is not set')
  })

  it('briefing and the session-start hook deliver memories and flag stale ones', async () => {
    const empty = brainCli(a, ['hook', 'session-start'], { input: JSON.stringify({ cwd: a }) })
    expect(JSON.parse(empty.out).hookSpecificOutput.additionalContext).toContain('(empty)')

    const head = git(a, 'rev-parse', 'HEAD')
    await remember(brain, idA, { kind: 'overview', title: 'Acme app', body: 'Tiny demo app.', importance: 5 })
    await remember(brain, idA, { kind: 'gotcha', title: 'App entry is fragile', body: 'Edit with care.', paths: ['app.ts'], commitSha: head })

    const fresh = JSON.parse(brainCli(a, ['hook', 'session-start'], { input: JSON.stringify({ cwd: a }) }).out)
    expect(fresh.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(fresh.hookSpecificOutput.additionalContext).toContain('Acme app')
    expect(fresh.hookSpecificOutput.additionalContext).not.toContain('may be stale')

    writeFileSync(join(a, 'app.ts'), '2')
    const stale = JSON.parse(brainCli(a, ['hook', 'session-start'], { input: JSON.stringify({ cwd: a }) }).out)
    expect(stale.hookSpecificOutput.additionalContext).toContain('may be stale (changed: app.ts)')

    const printed = brainCli(a, ['briefing', '--tokens', '400'])
    expect(printed.code).toBe(0)
    expect(printed.out).toContain('may be stale (changed: app.ts)')
  })

  it('hooks stay silent and succeed when the server is unreachable or the folder is unknown', () => {
    const down = brainCli(a, ['hook', 'session-start'], { input: JSON.stringify({ cwd: a }), env: env({ CAIRN_URL: 'http://127.0.0.1:1' }) })
    expect(down.code).toBe(0)
    expect(down.out).toBe('')

    const bare = mkdtempSync(join(tmpdir(), 'cairn-bare-'))
    dirs.push(bare)
    const none = brainCli(bare, ['hook', 'session-start'], { input: JSON.stringify({ cwd: bare }) })
    expect(none.code).toBe(0)
    expect(none.out).toBe('')

    expect(brainCli(a, ['hook', 'session-start'], { input: 'garbage' }).code).toBe(0)
    expect(brainCli(a, ['hook', 'nonsense']).code).toBe(0)
  })

  it('the stop hook demands a checkpoint only after real work without one', () => {
    const tx = (lines: unknown[]) => {
      const f = join(mkdtempSync(join(tmpdir(), 'cairn-tx-')), 't.jsonl')
      dirs.push(join(f, '..'))
      writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n'))
      return f
    }
    const prompt = { type: 'user', message: { content: 'do it' } }
    const edit = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } }
    const cp = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__cairn__cairn_checkpoint' }] } }
    const stop = (path: string, extra: object = {}) => brainCli(a, ['hook', 'stop'], { input: JSON.stringify({ cwd: a, transcript_path: path, ...extra }) })

    const work = tx([prompt, edit, edit, edit])
    const blocked = JSON.parse(stop(work).out)
    expect(blocked.decision).toBe('block')
    expect(blocked.reason).toContain('cairn_checkpoint')

    expect(stop(work, { stop_hook_active: true }).out).toBe('')
    expect(stop(tx([prompt, edit, edit])).out).toBe('')
    expect(stop(tx([prompt, edit, edit, edit, cp])).out).toBe('')
    expect(stop('/no/such/file.jsonl').code).toBe(0)
  })

  it('the pre-tool-use hook stamps the commit and author on memory writes only', () => {
    const head = git(a, 'rev-parse', 'HEAD')
    const input = { cwd: a, tool_name: 'mcp__cairn__cairn_remember', tool_input: { kind: 'gotcha', title: 't', body: 'b' } }
    const r = JSON.parse(brainCli(a, ['hook', 'pre-tool-use'], { input: JSON.stringify(input) }).out)
    expect(r.hookSpecificOutput.permissionDecision).toBe('allow')
    expect(r.hookSpecificOutput.updatedInput).toEqual({ kind: 'gotcha', title: 't', body: 'b', commit_sha: head, author: 'Test User' })

    const other = brainCli(a, ['hook', 'pre-tool-use'], { input: JSON.stringify({ ...input, tool_name: 'mcp__cairn__cairn_recall' }) })
    expect(other.out).toBe('')
  })

  it('remote adds another URL for the same project', () => {
    const r = brainCli(a, ['remote', `git@example.net:team/${run}-alias.git`, '--force'])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`Project "${idA}" now also answers to example.net/team/${run}-alias`)
    expect(brainCli(a, ['remote']).code).toBe(1)
  })

  it('unknown commands and help behave', () => {
    expect(brainCli(a, ['help']).out).toContain('cairn init')
    expect(brainCli(a, ['wat']).code).toBe(1)
  })
})
