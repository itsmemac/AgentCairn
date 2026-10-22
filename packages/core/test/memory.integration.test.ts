import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Brain,
  MemoryValidationError,
  ProjectMissingError,
  SupersedeError,
  ensureProject,
  ensureSchema,
  getMemory,
  loadConfig,
  openBrain,
  recall,
  remember,
  toLuceneQuery,
} from '../src/index.js'

describe('toLuceneQuery', () => {
  it('escapes syntax characters and collapses whitespace', () => {
    expect(toLuceneQuery('  foo:bar  (baz)* ')).toBe('foo\\:bar \\(baz\\)\\*')
    expect(toLuceneQuery('')).toBe('')
    expect(toLuceneQuery('a-b "c"')).toBe('a\\-b \\"c\\"')
  })
})

describe.skipIf(!process.env.NEO4J_URI)('memories against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const proj = `${run}-mem`
  const other = `${run}-other`
  let brain: Brain

  const base = { kind: 'decision', title: 'Use Postgres', body: 'We chose Postgres for transactions.' } as const

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    await ensureProject(brain, proj)
    await ensureProject(brain, other)
  })

  afterAll(async () => {
    await brain.run('MATCH (n) WHERE n.projectId IN $ids DETACH DELETE n', { ids: [proj, other] })
    await brain.run('MATCH (p:Project) WHERE p.id IN $ids DETACH DELETE p', { ids: [proj, other] })
    await brain.close()
  })

  it('stores a memory with defaults and reads it back', async () => {
    const m = await remember(brain, proj, { ...base, area: ' Storage ', paths: ['db/schema.sql'], commitSha: 'abc123' })
    expect(m).toMatchObject({
      projectId: proj,
      kind: 'decision',
      title: 'Use Postgres',
      area: 'storage',
      paths: ['db/schema.sql'],
      importance: 3,
      status: 'active',
      supersedes: [],
      commitSha: 'abc123',
      author: null,
    })
    expect(m.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(await getMemory(brain, proj, m.id)).toEqual(m)
    expect(await getMemory(brain, other, m.id)).toBeNull()
  })

  it('validates input', async () => {
    const bad = [
      { ...base, kind: 'nope' as never },
      { ...base, title: '  ' },
      { ...base, body: '' },
      { ...base, importance: 9 },
      { ...base, area: ' ' },
      { ...base, paths: [''] },
    ]
    for (const input of bad) {
      await expect(remember(brain, proj, input)).rejects.toBeInstanceOf(MemoryValidationError)
    }
  })

  it('rejects memories for a missing project', async () => {
    await expect(remember(brain, `${run}-ghost`, base)).rejects.toBeInstanceOf(ProjectMissingError)
  })

  it('supersede keeps history, hides the old one and links them', async () => {
    const old = await remember(brain, proj, { ...base, title: 'Use MySQL', body: 'Initial choice: MySQL.' })
    const next = await remember(brain, proj, {
      ...base,
      title: 'Use SQLite',
      body: 'Switched to SQLite for simplicity.',
      supersedes: [old.id],
    })
    expect(next.supersedes).toEqual([old.id])
    expect((await getMemory(brain, proj, old.id))?.status).toBe('superseded')

    const active = await recall(brain, proj, { query: 'MySQL' })
    expect(active.map(m => m.id)).not.toContain(old.id)
    const all = await recall(brain, proj, { query: 'MySQL', includeSuperseded: true })
    expect(all.map(m => m.id)).toContain(old.id)
  })

  it('supersede fails atomically for foreign, missing or already superseded ids', async () => {
    const a = await remember(brain, proj, { ...base, title: 'Alpha thing', body: 'alpha body' })
    const foreign = await remember(brain, other, { ...base, title: 'Foreign', body: 'foreign body' })

    for (const ids of [[foreign.id], ['nonexistent'], [a.id, foreign.id]]) {
      await expect(remember(brain, proj, { ...base, title: 'X', body: 'x', supersedes: ids })).rejects.toBeInstanceOf(
        SupersedeError,
      )
    }
    expect((await getMemory(brain, proj, a.id))?.status).toBe('active')
    expect((await getMemory(brain, other, foreign.id))?.status).toBe('active')

    const beta = await remember(brain, proj, { ...base, title: 'Beta', body: 'beta', supersedes: [a.id] })
    await expect(
      remember(brain, proj, { ...base, title: 'Gamma', body: 'gamma', supersedes: [a.id] }),
    ).rejects.toBeInstanceOf(SupersedeError)

    // the message says what is wrong with each id, and what to use instead
    const reason = (ids: string[]) => remember(brain, proj, { ...base, title: 'Why', body: 'why', supersedes: ids }).then(() => '', (e: Error) => e.message)
    expect(await reason([`#${a.id.slice(0, 8)}`])).toContain(`#${a.id.slice(0, 8)} was already replaced by #${beta.id.slice(0, 8)}`)
    expect(await reason(['deadbeefdead'])).toContain('is not a memory of this project')
    expect(await reason([foreign.id])).toContain('is not a memory of this project')
    expect(await reason(['abc'])).toContain('is not a memory of this project')
    expect(await reason([a.id, 'deadbeefdead'])).toMatch(/already replaced.*Nothing was written/s)
  })

  it('keeps review_by, revisit_when and who wrote it, and rejects a bad review day', async () => {
    const m = await remember(brain, proj, { ...base, title: 'Time bound', body: 'true for now', reviewBy: '2999-12-31', revisitWhen: 'the API v2 ships', writtenBy: 'ann', viaToken: 'laptop' })
    const got = await getMemory(brain, proj, m.id)
    expect(got).toMatchObject({ reviewBy: '2999-12-31', revisitWhen: 'the API v2 ships', writtenBy: 'ann', viaToken: 'laptop' })
    const plain = await remember(brain, proj, { ...base, title: 'Plain', body: 'nothing extra' })
    expect(plain).toMatchObject({ reviewBy: null, revisitWhen: null, writtenBy: null, viaToken: null })
    for (const reviewBy of ['tomorrow', '2026-13-45', '31/12/2026']) {
      await expect(remember(brain, proj, { ...base, title: 'Bad', body: 'bad', reviewBy })).rejects.toBeInstanceOf(MemoryValidationError)
    }
  })

  it('concurrent supersedes of one memory: exactly one wins', async () => {
    const target = await remember(brain, proj, { ...base, title: 'Contested', body: 'contested body' })
    const attempts = await Promise.allSettled(
      [1, 2, 3].map(i =>
        remember(brain, proj, { ...base, title: `Rival ${i}`, body: `rival ${i}`, supersedes: [target.id] }),
      ),
    )
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(2)
  })

  it('recall searches fulltext, scoped to the project', async () => {
    const needle = `zebracorn${run}`
    const mine = await remember(brain, proj, { ...base, title: `About ${needle}`, body: 'stripes everywhere' })
    await remember(brain, other, { ...base, title: `Other ${needle}`, body: 'not visible here' })

    const hits = await recall(brain, proj, { query: needle })
    expect(hits.map(h => h.id)).toEqual([mine.id])
    expect(hits[0]!.score).toBeGreaterThan(0)
  })

  it('recall survives query syntax characters', async () => {
    await expect(recall(brain, proj, { query: 'foo: (bar* AND "baz' })).resolves.toBeInstanceOf(Array)
  })

  it('recall filters by kind and area, and lists by importance without a query', async () => {
    const tag = `lst${run}`
    const lowGotcha = await remember(brain, proj, { kind: 'gotcha', title: `${tag} low`, body: 'b', area: 'api', importance: 1 })
    const highGotcha = await remember(brain, proj, { kind: 'gotcha', title: `${tag} high`, body: 'b', area: 'api', importance: 5 })
    await remember(brain, proj, { kind: 'convention', title: `${tag} conv`, body: 'b', area: 'web' })

    const gotchasInApi = await recall(brain, proj, { kind: 'gotcha', area: 'API' })
    expect(gotchasInApi.map(m => m.id).slice(0, 2)).toEqual([highGotcha.id, lowGotcha.id])
    expect(gotchasInApi.every(m => m.kind === 'gotcha' && m.area === 'api')).toBe(true)

    const viaQuery = await recall(brain, proj, { query: tag, area: 'web' })
    expect(viaQuery).toHaveLength(1)
    expect(viaQuery[0]!.kind).toBe('convention')
  })

  it('recall honours the limit', async () => {
    expect((await recall(brain, proj, { limit: 2 })).length).toBeLessThanOrEqual(2)
  })
})
