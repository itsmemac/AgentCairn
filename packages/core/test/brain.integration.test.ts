import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Brain,
  ProjectNotFoundError,
  RemoteConflictError,
  UnresolvedProjectError,
  attachRemote,
  checkConnection,
  ensureProject,
  ensureSchema,
  findLink,
  findProjectByRemote,
  initProject,
  loadConfig,
  openBrain,
  resolveProject,
  schemaVersion,
  SCHEMA_VERSION,
} from '../src/index.js'

// Runs only when NEO4J_URI is set (env or the repo's git-ignored .env).
const enabled = Boolean(process.env.NEO4J_URI)

describe.skipIf(!enabled)('against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const projects = [`${run}-a`, `${run}-b`]
  const hashes = [`${run}0001`, `${run}0002`].map(h => h.padEnd(16, '0').slice(0, 16))
  const dirs: string[] = []
  let brain: Brain

  const repo = (remote?: string) => {
    const d = mkdtempSync(join(tmpdir(), 'cairn-it-'))
    dirs.push(d)
    execFileSync('git', ['init', '-q'], { cwd: d })
    if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: d })
    return d
  }

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
  })

  afterAll(async () => {
    await brain.run(
      'MATCH (p:Project) WHERE p.id IN $ids OR p.id STARTS WITH $git DETACH DELETE p',
      { ids: projects, git: 'git-' + run },
    )
    await brain.run('MATCH (r:Remote) WHERE r.hash IN $h DETACH DELETE r', { h: hashes })
    await brain.run('MATCH (r:Remote) WHERE NOT (r)-[:BELONGS_TO]->() DETACH DELETE r')
    await brain.close()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('connects and creates the schema idempotently', async () => {
    const info = await checkConnection(brain)
    expect(info.agent).toMatch(/neo4j/i)
    await ensureSchema(brain)
    expect(await schemaVersion(brain)).toBe(SCHEMA_VERSION)
  })

  it('ensureProject reports creation once', async () => {
    expect(await ensureProject(brain, projects[0]!)).toEqual({ created: true })
    expect(await ensureProject(brain, projects[0]!)).toEqual({ created: false })
  })

  it('attaches a remote, rejects a second owner, allows force', async () => {
    await ensureProject(brain, projects[1]!)
    await attachRemote(brain, projects[0]!, hashes[0]!)
    expect(await findProjectByRemote(brain, hashes[0]!)).toBe(projects[0])
    await expect(attachRemote(brain, projects[1]!, hashes[0]!)).rejects.toBeInstanceOf(RemoteConflictError)
    await attachRemote(brain, projects[1]!, hashes[0]!, { force: true })
    expect(await findProjectByRemote(brain, hashes[0]!)).toBe(projects[1])
  })

  it('cairn init <projectId> links a folder whose remote matches nothing', async () => {
    const dir = repo('git@example.com:someone-else/fork.git')
    await expect(initProject(brain, dir, `${run}-new`)).rejects.toBeInstanceOf(ProjectNotFoundError)

    const result = await initProject(brain, dir, projects[0]!)
    expect(result).toMatchObject({ projectId: projects[0], created: false, remoteAttached: true })
    expect(await findLink(dir)).toMatchObject({ projectId: projects[0] })

    const resolved = await resolveProject(brain, dir)
    expect(resolved).toMatchObject({ projectId: projects[0], source: 'link', isNew: false })
  })

  it('another clone with the same remote resolves to the linked project', async () => {
    const first = repo('https://example.com/team/shared.git')
    await initProject(brain, first, projects[0]!)

    const second = repo('git@example.com:Team/Shared.git')
    const resolved = await resolveProject(brain, second)
    expect(resolved).toMatchObject({ projectId: projects[0], source: 'remote', isNew: false })
  })

  it('an unknown remote resolves to a fresh git-<hash> id without writing', async () => {
    const dir = repo(`https://example.com/${run}/unseen.git`)
    const resolved = await resolveProject(brain, dir)
    expect(resolved.projectId).toMatch(/^git-[0-9a-f]{16}$/)
    expect(resolved).toMatchObject({ source: 'remote', isNew: true })
    expect(await findProjectByRemote(brain, resolved.remoteHash!)).toBeNull()
  })

  it('init without id on a remote-less folder is unresolved', async () => {
    const dir = repo()
    await expect(initProject(brain, dir)).rejects.toBeInstanceOf(UnresolvedProjectError)
    await expect(resolveProject(brain, dir)).rejects.toBeInstanceOf(UnresolvedProjectError)
  })

  it('allowCreate makes a new project for a remote-less folder', async () => {
    const dir = repo()
    const result = await initProject(brain, dir, `${run}-b`, { allowCreate: true })
    expect(result).toMatchObject({ projectId: `${run}-b`, remoteAttached: false })
  })
})
