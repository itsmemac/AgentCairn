import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type Brain,
  getMemory,
  loadConfig,
  normalizeRemoteUrl,
  openBrain,
  projectExists,
  recall,
  remoteHash,
} from '@agentcairn/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBrainServer } from '../src/index.js'

type Call = { content: { type: string; text: string }[]; isError?: boolean }
const text = (r: unknown) => (r as Call).content.map(c => c.text).join('\n')
const shortIdIn = (s: string) => /#([0-9a-f]{8})/.exec(s)![1]!

describe.skipIf(!process.env.NEO4J_URI)('MCP server against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const remote = `https://example.com/${run}/repo.git`
  const projectId = `git-${remoteHash(normalizeRemoteUrl(remote)!)}`
  let brain: Brain
  let repo: string
  let head: string
  let client: Client

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as Call

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    repo = mkdtempSync(join(tmpdir(), 'cairn-mcp-'))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Tester')
    git(repo, 'remote', 'add', 'origin', remote)
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'auth.ts'), '1')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
    head = git(repo, 'rev-parse', 'HEAD')

    const server = createBrainServer(brain, repo)
    const [a, b] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '1.0.0' })
    await Promise.all([server.connect(a), client.connect(b)])
  })

  afterAll(async () => {
    await client.close()
    await brain.run('MATCH (n) WHERE n.projectId = $id DETACH DELETE n', { id: projectId })
    await brain.run('MATCH (p:Project {id: $id}) DETACH DELETE p', { id: projectId })
    await brain.run('MATCH (r:Remote) WHERE NOT (r)-[:BELONGS_TO]->() DETACH DELETE r')
    await brain.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('lists every tool and carries usage instructions', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'cairn_areas',
      'cairn_briefing',
      'cairn_checkpoint',
      'cairn_forget',
      'cairn_recall',
      'cairn_remember',
      'cairn_status',
    ])
    expect(client.getInstructions()).toContain('cairn_briefing')
  })

  it('briefing on an unknown project returns onboarding and writes nothing', async () => {
    const r = await call('cairn_briefing')
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('(empty)')
    expect(text(r)).toContain('cairn_remember')
    expect(await projectExists(brain, projectId)).toBe(false)
  })

  it('remember creates the project and records provenance', async () => {
    const r = await call('cairn_remember', {
      kind: 'overview',
      title: 'Acme API',
      body: 'REST service on Node. Build: npm run build.',
      importance: 5,
    })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toMatch(/^Remembered #[0-9a-f]{8}: Acme API/)
    expect(await projectExists(brain, projectId)).toBe(true)

    const m = await getMemory(brain, projectId, shortIdIn(text(r)))
    expect(m).toMatchObject({ agent: 'test-client', author: 'Tester', machine: hostname(), commitSha: head })
  })

  it('briefing now lists the memory, and recall finds it', async () => {
    const b = text(await call('cairn_briefing', { max_tokens: 500 }))
    expect(b).toContain('## Overview')
    expect(b).toContain('Acme API')
    expect(text(await call('cairn_recall', { query: 'Acme' }))).toContain('REST service on Node')
    expect(text(await call('cairn_recall', { query: 'nonexistent-term-xyz' }))).toBe('No matching memories.')
  })

  it('supersedes using the short id shown in a briefing', async () => {
    const first = await call('cairn_remember', {
      kind: 'convention',
      title: 'Tabs for indent',
      body: 'We indent with tabs.',
      area: 'Style',
    })
    const id = shortIdIn(text(first))
    const second = await call('cairn_remember', {
      kind: 'convention',
      title: 'Spaces for indent',
      body: 'We switched to two spaces.',
      area: 'Style',
      supersedes: [`#${id}`.replace('#', '')],
    })
    expect(text(second)).toContain(`replaced #${id}`)
    expect(text(await call('cairn_recall', { query: 'indent' }))).not.toContain('Tabs for indent')
    expect(text(await call('cairn_recall', { query: 'indent', include_superseded: true }))).toContain('Tabs for indent')
  })

  it('checkpoint stores decisions and a thread, and resolves old threads', async () => {
    const t1 = await call('cairn_remember', { kind: 'thread', title: 'Add rate limiting', body: 'Not done yet.' })
    const threadId = shortIdIn(text(t1))

    const cp = await call('cairn_checkpoint', {
      goal: 'Add rate limiting',
      outcome: 'Implemented a token bucket in src/limiter.ts.',
      decisions: [{ title: 'Token bucket over fixed window', body: 'Smoother bursts.', area: 'api' }],
      next: 'Document the limits',
      resolves: [threadId],
      paths: ['src/auth.ts'],
    })
    expect(cp.isError).toBeUndefined()
    expect(text(cp)).toMatch(/Checkpoint #[0-9a-f]{8} recorded\. 1 decision\(s\) stored\. Open thread #[0-9a-f]{8} created\. Resolved 1 thread\(s\)\./)

    const active = await recall(brain, projectId, { kind: 'thread' })
    expect(active.map(m => m.title)).toContain('Next after: Add rate limiting')
    expect(active.map(m => m.title)).not.toContain('Add rate limiting')
    const decisions = await recall(brain, projectId, { kind: 'decision' })
    expect(decisions[0]).toMatchObject({ title: 'Token bucket over fixed window', area: 'api' })
  })

  it('recall flags a memory whose path changed since it was written', async () => {
    writeFileSync(join(repo, 'src', 'auth.ts'), '2')
    const r = text(await call('cairn_recall', { query: 'bucket' }))
    expect(r).toContain('may be stale (changed: src/auth.ts)')
  })

  it('lists areas and reports status', async () => {
    const areas = text(await call('cairn_areas'))
    expect(areas).toMatch(/api: 1/)
    expect(areas).toMatch(/style: 1/)

    const status = text(await call('cairn_status'))
    expect(status).toContain(`Project: ${projectId} (via git remote)`)
    expect(status).toContain('Active memories:')
    expect(status).toContain(repo)
  })

  it('forget deletes a memory and restores what it superseded', async () => {
    const a = await call('cairn_remember', { kind: 'gotcha', title: 'Original gotcha', body: 'first' })
    const aId = shortIdIn(text(a))
    const b = await call('cairn_remember', { kind: 'gotcha', title: 'Replacement gotcha', body: 'second', supersedes: [aId] })
    const bId = shortIdIn(text(b))

    const gone = await call('cairn_forget', { id: `#${bId}` })
    expect(text(gone)).toContain('Restored 1 earlier memory')
    expect((await getMemory(brain, projectId, aId))?.status).toBe('active')
    expect(await getMemory(brain, projectId, bId)).toBeNull()

    const missing = await call('cairn_forget', { id: 'ffffffff' })
    expect(missing.isError).toBe(true)
  })

  it('reports problems to the agent instead of throwing', async () => {
    const invalid = await call('cairn_remember', { kind: 'decision', title: 'x', body: 'y', supersedes: ['deadbeef'] })
    expect(invalid.isError).toBe(true)
    expect(text(invalid)).toContain('Cannot supersede')

    const bad = await client.callTool({ name: 'cairn_remember', arguments: { kind: 'nope', title: 't', body: 'b' } }).catch(e => e)
    expect(bad instanceof Error || (bad as Call).isError).toBeTruthy()
  })

  it('an unidentifiable folder tells the agent to run cairn init', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'cairn-bare-'))
    try {
      const server = createBrainServer(brain, bare)
      const [a, b] = InMemoryTransport.createLinkedPair()
      const c = new Client({ name: 'bare', version: '1' })
      await Promise.all([server.connect(a), c.connect(b)])
      const r = (await c.callTool({ name: 'cairn_briefing', arguments: {} })) as Call
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('cairn init')
      await c.close()
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('serves over real stdio without polluting stdout', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../dist/bin.js')],
      cwd: repo,
      env: { ...(process.env as Record<string, string>) },
      stderr: 'pipe',
    })
    const c = new Client({ name: 'stdio-client', version: '1' })
    await c.connect(transport)
    try {
      const r = (await c.callTool({ name: 'cairn_status', arguments: {} })) as Call
      expect(r.isError).toBeUndefined()
      expect(text(r)).toContain(`Project: ${projectId}`)
    } finally {
      await c.close()
    }
  })
})
