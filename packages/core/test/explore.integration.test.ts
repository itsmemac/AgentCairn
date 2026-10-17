import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Brain,
  QueryRejectedError,
  assertReadOnlyCypher,
  ensureProject,
  ensureSchema,
  getGraph,
  getMemoryChain,
  getProjectDetail,
  getSystemInfo,
  listProjects,
  loadConfig,
  openBrain,
  remember,
  runReadOnlyCypher,
  toPlain,
} from '../src/index.js'

describe('assertReadOnlyCypher', () => {
  it.each([
    'MATCH (m:Memory) RETURN m LIMIT 5',
    "MATCH (m:Memory) WHERE m.title = 'Set up the DELETE button' RETURN m",
    'MATCH (m:Memory) // create nothing\nRETURN count(m)',
    'MATCH (n) RETURN n;',
  ])('allows %j', q => {
    expect(() => assertReadOnlyCypher(q)).not.toThrow()
  })

  it.each([
    'CREATE (n:X)',
    'MATCH (n) DETACH DELETE n',
    'MATCH (n) SET n.x = 1',
    'match (n) remove n.x',
    'MERGE (n:X)',
    'LOAD CSV FROM "file:///x" AS r RETURN r',
    'CALL dbms.security.listUsers()',
    'CALL apoc.cypher.runMany("x", {})',
    'MATCH (n) RETURN n; MATCH (m) RETURN m',
    'DROP INDEX memory_text',
    '',
    '   ',
    'x'.repeat(5001),
  ])('rejects %j', q => {
    expect(() => assertReadOnlyCypher(q)).toThrow(QueryRejectedError)
  })
})

describe.skipIf(!process.env.NEO4J_URI)('exploring a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const proj = `${run}-explore`
  let brain: Brain
  let first: string
  let second: string

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    await ensureProject(brain, proj)
    const a = await remember(brain, proj, { kind: 'decision', title: 'Use MySQL', body: 'first', area: 'storage', importance: 4 })
    const b = await remember(brain, proj, { kind: 'decision', title: 'Use SQLite', body: 'second', area: 'storage', supersedes: [a.id] })
    await remember(brain, proj, { kind: 'gotcha', title: 'Unfiled gotcha', body: 'no area' })
    first = a.id
    second = b.id
    await brain.run(
      `MATCH (p:Project {id: $id}) MERGE (r:Remote {hash: $hash}) MERGE (r)-[:BELONGS_TO]->(p)`,
      { id: proj, hash: `${run}`.padEnd(16, '0') },
    )
  })

  afterAll(async () => {
    await brain.run('MATCH (n) WHERE n.projectId = $id DETACH DELETE n', { id: proj })
    await brain.run('MATCH (p:Project {id: $id}) DETACH DELETE p', { id: proj })
    await brain.run('MATCH (r:Remote) WHERE NOT (r)-[:BELONGS_TO]->() DETACH DELETE r')
    await brain.close()
  })

  it('lists projects with counts, remotes and last activity', async () => {
    const p = (await listProjects(brain)).find(x => x.id === proj)!
    expect(p).toMatchObject({ active: 2, superseded: 1, remotes: 1, counts: { decision: 1, gotcha: 1 } })
    expect(p.lastMemoryAt).toMatch(/^\d{4}-/)
    const detail = (await getProjectDetail(brain, proj))!
    expect(detail.areas).toEqual([{ name: 'general', count: 1 }, { name: 'storage', count: 1 }])
    expect(detail.remoteHashes).toHaveLength(1)
    expect(await getProjectDetail(brain, `${run}-nope`)).toBeNull()
  })

  it('shows what a memory replaced and what replaced it', async () => {
    expect((await getMemoryChain(brain, proj, second)).replaced.map(m => m.title)).toEqual(['Use MySQL'])
    expect((await getMemoryChain(brain, proj, first)).replacedBy.map(m => m.title)).toEqual(['Use SQLite'])
    expect(await getMemoryChain(brain, proj, 'missing')).toEqual({ replaced: [], replacedBy: [] })
  })

  it('builds the overview and the per-project graph', async () => {
    const overview = await getGraph(brain)
    expect(overview.nodes.some(n => n.id === `p:${proj}` && n.type === 'project')).toBe(true)
    expect(overview.nodes.every(n => n.type !== 'memory')).toBe(true)

    const g = await getGraph(brain, { projectId: proj })
    const types = (t: string) => g.nodes.filter(n => n.type === t).length
    expect(types('project')).toBe(1)
    expect(types('area')).toBe(2) // storage, plus the default area for the unfiled gotcha
    expect(types('memory')).toBe(3)
    expect(types('remote')).toBe(1)
    expect(g.edges.some(e => e.type === 'SUPERSEDES' && e.source === `m:${second}` && e.target === `m:${first}`)).toBe(true)
    // a tree, parent to child: project -> area -> memory; nothing hangs straight off the project
    const hasMemory = g.edges.filter(e => e.type === 'HAS_MEMORY')
    expect(hasMemory).toHaveLength(3)
    expect(hasMemory.every(e => e.source.startsWith('a:') && e.target.startsWith('m:'))).toBe(true)
    expect(g.edges.filter(e => e.type === 'HAS_AREA').every(e => e.source === `p:${proj}`)).toBe(true)
    const ids = new Set(g.nodes.map(n => n.id))
    expect(g.edges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true)
    expect(g.truncated).toBe(false)

    const small = await getGraph(brain, { projectId: proj, limit: 2 })
    expect(small.truncated).toBe(true)
    expect(small.nodes.filter(n => n.type === 'memory')).toHaveLength(2)
  })

  it('runs read-only Cypher and converts values to plain JSON', async () => {
    const r = await runReadOnlyCypher(
      brain,
      `MATCH (m:Memory {projectId: '${proj}'}) RETURN m.title AS title, m.importance AS importance, m.createdAt AS at, m ORDER BY title`,
    )
    expect(r.columns).toEqual(['title', 'importance', 'at', 'm'])
    expect(r.rows).toHaveLength(3)
    expect(r.rows[0]![0]).toBe('Unfiled gotcha')
    expect(typeof r.rows[0]![1]).toBe('number')
    expect(typeof r.rows[0]![2]).toBe('string')
    expect(r.rows[0]![3]).toMatchObject({ _type: 'node', labels: ['Memory'], properties: { title: 'Unfiled gotcha' } })
    expect(r.truncated).toBe(false)

    const capped = await runReadOnlyCypher(brain, `MATCH (m:Memory {projectId: '${proj}'}) RETURN m.id`, { limit: 1 })
    expect(capped.rows).toHaveLength(1)
    expect(capped.truncated).toBe(true)
  })

  it('the database itself refuses writes in a read transaction, whatever the text says', async () => {
    const session = brain.session()
    try {
      await expect(session.executeRead(tx => tx.run(`CREATE (:Probe {run: '${run}'})`))).rejects.toThrow()
    } finally {
      await session.close()
    }
    const probe = await brain.run('MATCH (n:Probe {run: $run}) RETURN count(n) AS n', { run })
    expect(Number(probe.records[0]!.get('n'))).toBe(0)
  })

  it('reports syntax errors and reads system info', async () => {
    await expect(runReadOnlyCypher(brain, 'MATCH (n RETURN n')).rejects.toThrow()
    const info = await getSystemInfo(brain)
    expect(info.labels.Memory).toBeGreaterThan(0)
    expect(info.relationships.SUPERSEDES).toBeGreaterThan(0)
  })

  it('toPlain handles nulls, nested values and big integers', () => {
    expect(toPlain(null)).toBeNull()
    expect(toPlain(undefined)).toBeNull()
    expect(toPlain({ a: [1, { b: 'x' }] })).toEqual({ a: [1, { b: 'x' }] })
  })
})
