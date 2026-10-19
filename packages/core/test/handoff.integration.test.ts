import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Brain,
  HANDOFF_STATUSES,
  MemoryValidationError,
  SessionError,
  buildBriefing,
  deleteProject,
  ensureProject,
  ensureSchema,
  getMemory,
  listSessions,
  loadConfig,
  openBrain,
  recall,
  recordHandoff,
  remember,
  renderHandoff,
  upsertSession,
} from '../src/index.js'

describe('renderHandoff', () => {
  it('puts what to do next before how it got here, and keeps empty sections out', () => {
    const text = renderHandoff({
      goal: 'Ship users',
      done: ['Schema', 'Authorize'],
      inProgress: 'Writing the invite page; accept() is half done',
      next: ['Finish accept()', 'Add tests'],
      blockers: ['Which mail provider?'],
      deadEnds: ['Tried magic links in the URL hash: the proxy strips it'],
      fromUser: 'Never push without asking.',
      verify: 'npm test',
      workspace: { branch: 'main', head: 'abcdef1234567', dirty: ['a.ts', 'b.ts'] },
    })
    const order = ['Status: in progress', '## In progress', '## Next', '## Blocked or open', '## From the person', '## Tried and dropped', '## Done', '## How to check', '## Workspace']
    const at = order.map(h => text.indexOf(h))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text).toContain('1. Finish accept()')
    expect(text).toContain('branch main at abcdef1; 2 uncommitted files: a.ts, b.ts')
    expect(renderHandoff({ goal: 'x', next: ['y'] })).not.toContain('## Done')
  })

  it('removes secrets that slipped into it', () => {
    const text = renderHandoff({ goal: 'x', next: ['use aib_rNvYxu2-7lVJz_nGe7tW0Qs5H6jtHvj4 and the new password is Maccy@2026'] })
    expect(text).not.toContain('aib_rNv')
    expect(text).not.toContain('Maccy@2026')
  })
})

describe.skipIf(!process.env.NEO4J_URI)('handoffs and sessions against a live Neo4j', () => {
  const run = `t${randomBytes(4).toString('hex')}`
  const proj = `${run}-handoff`
  let brain: Brain

  beforeAll(async () => {
    brain = openBrain(loadConfig())
    await ensureSchema(brain)
    await ensureProject(brain, proj)
  })

  afterAll(async () => {
    await deleteProject(brain, proj)
    await brain.close()
  })

  it('a handoff replaces the previous one for the same topic and keeps the history', async () => {
    const first = await recordHandoff(brain, proj, { goal: 'Build the invite flow', next: ['Write the accept page'], topic: 'Main' })
    const second = await recordHandoff(brain, proj, { goal: 'Build the invite flow', done: ['Accept page'], next: ['Tests'], topic: 'main' })
    expect(second.handoff.supersedes).toEqual([first.handoff.id])
    expect((await getMemory(brain, proj, first.handoff.id))?.status).toBe('superseded')
    expect(second.handoff).toMatchObject({ kind: 'handoff', topic: 'main', status: 'active', area: 'handoff', importance: 4 })
    expect(second.handoff.body).toContain('1. Tests')

    const active = await recall(brain, proj, { kind: 'handoff' })
    expect(active.map(m => m.id)).toEqual([second.handoff.id])
  })

  it('different topics keep their own current handoff', async () => {
    const a = await recordHandoff(brain, proj, { goal: 'Graph rework', next: ['Collapse areas'], topic: 'graph' })
    const b = await recordHandoff(brain, proj, { goal: 'Docs pass', next: ['README'], topic: 'docs' })
    const active = (await recall(brain, proj, { kind: 'handoff', limit: 20 })).map(m => m.id)
    expect(active).toEqual(expect.arrayContaining([a.handoff.id, b.handoff.id]))
  })

  it('the branch is the topic when none is given, and decisions become their own memories', async () => {
    const r = await recordHandoff(brain, proj, {
      goal: 'Decide storage',
      next: ['Migrate'],
      workspace: { branch: 'feature/x', head: 'a'.repeat(40), dirty: [] },
      decisions: [{ title: 'Use Postgres', body: 'Spatial indexes.' }],
    })
    expect(r.handoff.topic).toBe('feature/x')
    expect(r.handoff.commitSha).toBe('a'.repeat(40))
    expect(r.decisions).toHaveLength(1)
    expect(r.decisions[0]).toMatchObject({ kind: 'decision', title: 'Use Postgres' })
  })

  it('refuses an empty handoff, an unknown status and a missing goal', async () => {
    await expect(recordHandoff(brain, proj, { goal: 'x' })).rejects.toBeInstanceOf(MemoryValidationError)
    await expect(recordHandoff(brain, proj, { goal: '  ', next: ['a'] })).rejects.toBeInstanceOf(MemoryValidationError)
    await expect(recordHandoff(brain, proj, { goal: 'x', next: ['a'], status: 'weird' as never })).rejects.toBeInstanceOf(MemoryValidationError)
    expect(HANDOFF_STATUSES).toContain('blocked')
  })

  it('stores a session snapshot, updates it in place, and never erases what was recorded earlier', async () => {
    const id = `s-${run}`
    const first = await upsertSession(brain, proj, {
      sessionId: id,
      machine: 'laptop',
      agent: 'claude-code',
      startedAt: '2026-10-20T10:00:00Z',
      branch: 'main',
      head: 'abc1234',
      prompts: [{ at: '2026-10-20T10:00:00Z', text: 'Add invites. My password is hunter2hunter2 by the way.' }],
      touched: ['src/a.ts'],
      dirty: ['src/a.ts', 'src/b.ts'],
      lastReply: 'Started on the accept page.',
      tools: { Edit: 3, Bash: 5 },
    })
    expect(first).toMatchObject({ id, machine: 'laptop', agent: 'claude-code', branch: 'main', touched: ['src/a.ts'], dirty: ['src/a.ts', 'src/b.ts'], tools: { Edit: 3, Bash: 5 } })
    expect(first.prompts[0]!.text).not.toContain('hunter2hunter2')

    // a later, thinner snapshot (no prompts, no files) adds to it and does not blank it
    const second = await upsertSession(brain, proj, { sessionId: id, endedAt: '2026-10-20T11:00:00Z', dirty: [] })
    expect(second).toMatchObject({ id, machine: 'laptop', endedAt: '2026-10-20T11:00:00Z', touched: ['src/a.ts'], dirty: [], lastReply: 'Started on the accept page.' })
    expect(second.prompts).toHaveLength(1)
    expect(second.startedAt).toBe('2026-10-20T10:00:00Z')
    expect((await listSessions(brain, proj)).filter(s => s.id === id)).toHaveLength(1)
  })

  it('caps what a session can hold and rejects an unusable id', async () => {
    const s = await upsertSession(brain, proj, {
      sessionId: `big-${run}`,
      prompts: Array.from({ length: 30 }, (_, i) => ({ text: `ask ${i} ${'x'.repeat(2000)}` })),
      touched: Array.from({ length: 500 }, (_, i) => `f${i}.ts`),
      lastReply: 'y'.repeat(20_000),
    })
    expect(s.prompts).toHaveLength(8)
    expect(s.prompts[0]!.text.length).toBeLessThanOrEqual(800)
    expect(s.touched).toHaveLength(120)
    expect(s.lastReply!.length).toBeLessThanOrEqual(3000)
    await expect(upsertSession(brain, proj, { sessionId: 'has spaces' })).rejects.toBeInstanceOf(SessionError)
    await expect(upsertSession(brain, `${run}-nope`, { sessionId: 'ok' })).rejects.toBeInstanceOf(SessionError)
  })

  it('lists the most recently active sessions first', async () => {
    await upsertSession(brain, proj, { sessionId: `old-${run}`, machine: 'a' })
    await new Promise(r => setTimeout(r, 30))
    await upsertSession(brain, proj, { sessionId: `new-${run}`, machine: 'b' })
    const ids = (await listSessions(brain, proj, { limit: 2 })).map(s => s.id)
    expect(ids[0]).toBe(`new-${run}`)
  })

  it('the briefing opens with where the work was left, then the recent sessions, and says where to resume from', async () => {
    await remember(brain, proj, { kind: 'overview', title: 'The project', body: 'What it is.', importance: 5 })
    const now = await recordHandoff(brain, proj, {
      goal: 'Finish the resume feature',
      inProgress: 'Wiring the hook',
      next: ['Write the tests'],
      deadEnds: ['A cron job cannot see the transcript'],
      topic: 'resume',
      workspace: { branch: 'resume', head: 'b'.repeat(40), dirty: ['hook.ts'] },
      machine: 'laptop',
    })
    const b = await buildBriefing(brain, proj, { maxTokens: 2000 })
    const left = b.text.indexOf('## Where we left off')
    const recent = b.text.indexOf('## Recent sessions')
    const overview = b.text.indexOf('## Overview')
    expect(left).toBeGreaterThan(-1)
    expect(left).toBeLessThan(recent)
    expect(recent).toBeLessThan(overview)
    expect(b.text).toContain('Wiring the hook')
    expect(b.text).toContain('A cron job cannot see the transcript')
    expect(b.includedIds).toContain(now.handoff.id)
    expect(b.resume).toMatchObject({ handoffId: now.handoff.id, topic: 'resume', commitSha: 'b'.repeat(40), machine: 'laptop' })
    expect(b.resume?.session).toMatchObject({ id: `new-${run}` })
    expect(b.tokens).toBeLessThanOrEqual(2000)
  })

  it('a small budget still fits, and an empty project shows its sessions under the onboarding text', async () => {
    const tight = await buildBriefing(brain, proj, { maxTokens: 250 })
    expect(tight.tokens).toBeLessThanOrEqual(250)

    const bare = `${run}-bare`
    await ensureProject(brain, bare)
    try {
      await upsertSession(brain, bare, { sessionId: `b-${run}`, prompts: [{ text: 'Start the migration' }], machine: 'pc' })
      const b = await buildBriefing(brain, bare)
      expect(b.status).toBe('empty')
      expect(b.text).toContain('## Recent sessions')
      expect(b.text).toContain('Start the migration')
    } finally {
      await deleteProject(brain, bare)
    }
  })

  it('recall can list newest first or oldest first', async () => {
    const p = `${run}-sort`
    await ensureProject(brain, p)
    try {
      const a = await remember(brain, p, { kind: 'gotcha', title: 'First', body: 'a', importance: 5 })
      await new Promise(r => setTimeout(r, 20))
      const b = await remember(brain, p, { kind: 'gotcha', title: 'Second', body: 'b', importance: 1 })
      expect((await recall(brain, p, {})).map(m => m.id)).toEqual([a.id, b.id]) // by importance
      expect((await recall(brain, p, { sort: 'recent' })).map(m => m.id)).toEqual([b.id, a.id])
      expect((await recall(brain, p, { sort: 'oldest' })).map(m => m.id)).toEqual([a.id, b.id])
    } finally {
      await deleteProject(brain, p)
    }
  })

  it('deleting a project removes its sessions', async () => {
    const p = `${run}-del`
    await ensureProject(brain, p)
    await upsertSession(brain, p, { sessionId: `d-${run}` })
    expect(await deleteProject(brain, p)).toMatchObject({ sessions: 1 })
    const left = await brain.run('MATCH (s:Session {projectId: $p}) RETURN count(s) AS n', { p })
    expect(Number(left.records[0]?.get('n'))).toBe(0)
  })
})
