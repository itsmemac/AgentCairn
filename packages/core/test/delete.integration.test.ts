import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Brain,
  attachRemote,
  deleteProject,
  ensureProject,
  ensureSchema,
  findProjectByRemote,
  getMemory,
  loadConfig,
  openBrain,
  projectExists,
  recall,
  remember,
} from '../src/index.js'

describe.skipIf(!process.env.NEO4J_URI)('deleting a project against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const doomed = `${run}-doomed`
  const kept = `${run}-kept`
  const hash = `h${randomBytes(6).toString('hex')}`
  let brain: Brain

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    await ensureProject(brain, doomed)
    await ensureProject(brain, kept)
  })

  afterAll(async () => {
    for (const id of [doomed, kept]) await deleteProject(brain, id)
    await brain.close()
  })

  it('removes the project, its memories, areas and remotes, and nothing else', async () => {
    const first = await remember(brain, doomed, { kind: 'gotcha', title: 'Old fact', body: 'Will be superseded.', area: 'storage' })
    await remember(brain, doomed, { kind: 'gotcha', title: 'New fact', body: 'Replaces the old one.', area: 'storage', supersedes: [first.id] })
    await remember(brain, doomed, { kind: 'decision', title: 'Another', body: 'In the default area.' })
    const survivor = await remember(brain, kept, { kind: 'decision', title: 'Stays', body: 'Belongs to another project.' })
    await attachRemote(brain, doomed, hash)

    expect(await deleteProject(brain, doomed)).toEqual({ memories: 3, areas: 2, remotes: 1 })

    expect(await projectExists(brain, doomed)).toBe(false)
    expect(await findProjectByRemote(brain, hash)).toBeNull()
    expect(await getMemory(brain, doomed, first.id)).toBeNull()
    expect(await recall(brain, doomed, { query: 'fact', includeSuperseded: true })).toEqual([])
    const left = await brain.run('MATCH (n) WHERE n.projectId = $id OR n.id STARTS WITH $id + $sep RETURN count(n) AS n', { id: doomed, sep: ':' })
    expect(Number(left.records[0]?.get('n'))).toBe(0)

    expect(await projectExists(brain, kept)).toBe(true)
    expect((await getMemory(brain, kept, survivor.id))?.title).toBe('Stays')
  })

  it('returns null for a project that does not exist, and is safe to repeat', async () => {
    expect(await deleteProject(brain, `${run}-never`)).toBeNull()
    expect(await deleteProject(brain, doomed)).toBeNull()
  })
})
