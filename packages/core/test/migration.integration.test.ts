import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Brain, ensureProject, ensureSchema, getGraph, listAreas, loadConfig, migrateContainment, openBrain, recall, remember } from '../src/index.js'

describe.skipIf(!process.env.NEO4J_URI)('containment is a tree: Project -> Area -> Memory', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const proj = `${run}-tree`
  let brain: Brain

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    await ensureProject(brain, proj)
  })
  afterAll(async () => {
    await brain.run('MATCH (n) WHERE n.projectId = $id DETACH DELETE n', { id: proj })
    await brain.run('MATCH (p:Project {id: $id}) DETACH DELETE p', { id: proj })
    await brain.close()
  })

  it('new memories hang off their area, never straight off the project', async () => {
    await remember(brain, proj, { kind: 'gotcha', title: 'Filed', body: 'in an area', area: 'api' })
    await remember(brain, proj, { kind: 'gotcha', title: 'Unfiled', body: 'no area given' })

    const direct = await brain.run('MATCH (:Project {id: $id})-[r:HAS_MEMORY]->() RETURN count(r) AS n', { id: proj })
    expect(Number(direct.records[0]!.get('n'))).toBe(0)
    const about = await brain.run('MATCH (m:Memory {projectId: $id})-[r:ABOUT]->() RETURN count(r) AS n', { id: proj })
    expect(Number(about.records[0]!.get('n'))).toBe(0)

    const parents = await brain.run('MATCH (m:Memory {projectId: $id}) RETURN m.title AS t, [(a:Area)-[:HAS_MEMORY]->(m) | a.name] AS areas ORDER BY t', { id: proj })
    expect(parents.records.map(r => [r.get('t'), r.get('areas')])).toEqual([['Filed', ['api']], ['Unfiled', ['general']]])
    expect((await listAreas(brain, proj)).map(a => a.name).sort()).toEqual(['api', 'general'])
    expect((await recall(brain, proj, { area: 'general' })).map(m => m.title)).toEqual(['Unfiled'])
  })

  it('converts the old flat shape in place, and leaves a converted database alone', async () => {
    // build the old shape by hand: Project -> Memory directly, memory -> area via ABOUT, one memory with no area at all
    await brain.run(
      `MATCH (p:Project {id: $id})
       CREATE (a:Area {id: $id + ':legacy', projectId: $id, name: 'legacy'}), (p)-[:HAS_AREA]->(a)
       CREATE (m1:Memory {id: $id + '-m1', projectId: $id, kind: 'gotcha', title: 'Old filed', body: 'b', importance: 3, status: 'active', paths: [], createdAt: datetime()})
       CREATE (m2:Memory {id: $id + '-m2', projectId: $id, kind: 'gotcha', title: 'Old unfiled', body: 'b', importance: 3, status: 'active', paths: [], createdAt: datetime()})
       CREATE (p)-[:HAS_MEMORY]->(m1), (p)-[:HAS_MEMORY]->(m2), (m1)-[:ABOUT]->(a)`,
      { id: proj },
    )
    expect(await migrateContainment(brain)).toBe(true)

    const shape = await brain.run(
      `MATCH (m:Memory) WHERE m.id STARTS WITH $id + '-m'
       RETURN m.title AS t, [(a:Area)-[:HAS_MEMORY]->(m) | a.name] AS areas,
              size([(:Project)-[:HAS_MEMORY]->(m) | 1]) AS direct, size([(m)-[:ABOUT]->() | 1]) AS about ORDER BY t`,
      { id: proj },
    )
    expect(shape.records.map(r => [r.get('t'), r.get('areas'), Number(r.get('direct')), Number(r.get('about'))])).toEqual([
      ['Old filed', ['legacy'], 0, 0],
      ['Old unfiled', ['general'], 0, 0],
    ])
    expect(await migrateContainment(brain)).toBe(false) // nothing left to do

    const g = await getGraph(brain, { projectId: proj })
    expect(g.edges.filter(e => e.type === 'HAS_MEMORY').every(e => e.source.startsWith('a:'))).toBe(true)
  })
})
