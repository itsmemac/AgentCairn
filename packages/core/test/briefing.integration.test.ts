import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Brain,
  buildBriefing,
  ensureProject,
  ensureSchema,
  getMemory,
  loadConfig,
  openBrain,
  remember,
} from '../src/index.js'

describe.skipIf(!process.env.NEO4J_URI)('briefing against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const proj = `${run}-brief`
  let brain: Brain
  let dir: string

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim()

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    await ensureProject(brain, proj)
    dir = mkdtempSync(join(tmpdir(), 'cairn-b-'))
    git('init', '-q')
    writeFileSync(join(dir, 'auth.ts'), '1')
    git('add', '-A')
    git('commit', '-qm', 'init')
  })

  afterAll(async () => {
    await brain.run('MATCH (n) WHERE n.projectId = $id DETACH DELETE n', { id: proj })
    await brain.run('MATCH (p:Project {id: $id}) DETACH DELETE p', { id: proj })
    await brain.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the onboarding prompt for an empty brain', async () => {
    const b = await buildBriefing(brain, proj)
    expect(b.status).toBe('empty')
    expect(b.text).toContain('cairn_remember')
    expect(b.text).toContain('overview')
    expect(b.includedIds).toEqual([])
  })

  it('builds a briefing, flags a memory whose file changed, and resolves short ids', async () => {
    const sha = git('rev-parse', 'HEAD')
    const overview = await remember(brain, proj, {
      kind: 'overview',
      title: 'Acme API',
      body: 'REST service on Node. Build with npm run build.',
      importance: 5,
    })
    const auth = await remember(brain, proj, {
      kind: 'gotcha',
      title: 'Auth tokens expire silently',
      body: 'Refresh happens in auth.ts.',
      paths: ['auth.ts'],
      commitSha: sha,
    })

    const fresh = await buildBriefing(brain, proj, { cwd: dir })
    expect(fresh.status).toBe('ready')
    expect(fresh.staleIds).toEqual([])
    expect(fresh.includedIds).toEqual(expect.arrayContaining([overview.id, auth.id]))
    expect(fresh.text).toContain('Acme API')

    writeFileSync(join(dir, 'auth.ts'), '2')
    const stale = await buildBriefing(brain, proj, { cwd: dir, maxTokens: 400 })
    expect(stale.staleIds).toEqual([auth.id])
    expect(stale.text).toContain('may be stale (changed: auth.ts)')
    expect(stale.tokens).toBeLessThanOrEqual(400)

    const shortId = auth.id.slice(0, 8)
    expect(stale.text).toContain(`#${shortId}`)
    expect((await getMemory(brain, proj, shortId))?.id).toBe(auth.id)
    expect(await getMemory(brain, proj, 'abc')).toBeNull()
  })
})
