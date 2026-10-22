import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleBriefing, estimateTokens } from '../src/briefing.js'
import { MEMORY_KINDS, type Memory, type MemoryKind } from '../src/memory.js'
import { checkStaleness } from '../src/staleness.js'

const NOW = new Date('2026-10-18T12:00:00Z')
let seq = 0

const mem = (kind: MemoryKind, over: Partial<Memory> = {}): Memory => ({
  id: `${(++seq).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`,
  projectId: 'p',
  kind,
  title: `${kind} ${seq}`,
  body: `Body of ${kind} ${seq}. `.repeat(10),
  area: null,
  paths: [],
  importance: 3,
  status: 'active',
  supersedes: [],
  commitSha: null,
  author: null,
  agent: null,
  machine: null,
  createdAt: '2026-10-10T00:00:00Z',
  score: undefined,
  ...over,
} as Memory)

const totals = (ms: Memory[]) => {
  const t = new Map<MemoryKind, number>()
  for (const m of ms) if (m.status === 'active') t.set(m.kind, (t.get(m.kind) ?? 0) + 1)
  return t
}

const build = (ms: Memory[], maxTokens: number, stale = new Map()) =>
  assembleBriefing('p', ms, stale, totals(ms), { maxTokens, now: NOW })

describe('assembleBriefing', () => {
  const many = () =>
    MEMORY_KINDS.flatMap(kind => Array.from({ length: 12 }, () => mem(kind, { importance: 1 + (seq % 5) })))

  it.each([200, 400, 800, 1500, 4000])('never exceeds the %i token budget', max => {
    const b = build(many(), max)
    expect(b.tokens).toBeLessThanOrEqual(max)
    expect(estimateTokens(b.text)).toBe(b.tokens)
  })

  it('clamps absurd budgets', () => {
    expect(build(many(), 5).tokens).toBeLessThanOrEqual(200)
  })

  it('orders sections by priority and puts the most important memory first', () => {
    const low = mem('convention', { importance: 1, title: 'low conv' })
    const high = mem('convention', { importance: 5, title: 'high conv' })
    const b = build([mem('decision'), low, high, mem('overview', { title: 'the overview' })], 2000)
    const t = b.text
    expect(t.indexOf('## Overview')).toBeLessThan(t.indexOf('## Conventions'))
    expect(t.indexOf('## Conventions')).toBeLessThan(t.indexOf('## Decisions'))
    expect(t.indexOf('high conv')).toBeLessThan(t.indexOf('low conv'))
  })

  it('shortens long bodies and says how many memories were left out', () => {
    const big = Array.from({ length: 40 }, () => mem('gotcha', { body: 'x'.repeat(2000) }))
    const b = build(big, 600)
    expect(b.omitted).toBeGreaterThan(0)
    expect(b.text).toContain('more memories not shown')
    expect(b.text).toContain('…')
    expect(b.includedIds.length + b.omitted).toBe(40)
  })

  it('ignores superseded memories', () => {
    const gone = mem('convention', { status: 'superseded', title: 'old rule' })
    expect(build([gone, mem('overview')], 1000).text).not.toContain('old rule')
  })

  it('flags a memory whose review day has passed, and shows when to revisit it', () => {
    const due = mem('convention', { title: 'due one', reviewBy: '2026-01-01', revisitWhen: 'the proxy is gone' })
    const later = mem('convention', { title: 'later one', reviewBy: '2999-01-01' })
    const text = build([due, later], 2000).text
    expect(text).toMatch(/due one.*revisit when: the proxy is gone.*review was due 2026-01-01/)
    expect(text).not.toMatch(/later one.*review was due/)
    expect(text).toContain('review date has passed')
  })

  it('flags stale memories and ranks them below fresh ones of equal weight', () => {
    const stale = mem('convention', { title: 'stale one', paths: ['a.ts'] })
    const fresh = mem('convention', { title: 'fresh one' })
    const st = new Map([[stale.id, { status: 'stale' as const, changedPaths: ['a.ts'] }]])
    const b = build([stale, fresh, mem('overview')], 2000, st)
    expect(b.staleIds).toEqual([stale.id])
    expect(b.text).toContain('may be stale (changed: a.ts)')
    expect(b.text.indexOf('fresh one')).toBeLessThan(b.text.indexOf('stale one'))
  })

  it('prefers newer checkpoints and notes a missing overview', () => {
    const oldCp = mem('checkpoint', { title: 'old cp', createdAt: '2026-01-01T00:00:00Z' })
    const newCp = mem('checkpoint', { title: 'new cp', createdAt: '2026-10-17T00:00:00Z' })
    const b = build([oldCp, newCp, mem('gotcha')], 2000)
    expect(b.text.indexOf('new cp')).toBeLessThan(b.text.indexOf('old cp'))
    expect(b.text).toContain('Last checkpoint: 2026-10-17')
    expect(b.text).toContain('No overview recorded yet')
  })
})

describe('checkStaleness', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
  const put = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }

  const repo = () => {
    const d = mkdtempSync(join(tmpdir(), 'cairn-st-'))
    dirs.push(d)
    git(d, 'init', '-q')
    put(d, 'src/a.ts', '1')
    put(d, 'src/b.ts', '1')
    put(d, 'docs/x.md', '1')
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'one')
    return { d, sha: git(d, 'rev-parse', 'HEAD') }
  }

  it('reports fresh, stale (committed, uncommitted, deleted, directory) and unchecked', async () => {
    const { d, sha } = repo()
    const ms = [
      { id: 'a', commitSha: sha, paths: ['src/a.ts'] },
      { id: 'b', commitSha: sha, paths: ['src/b.ts'] },
      { id: 'dir', commitSha: sha, paths: ['src/'] },
      { id: 'docs', commitSha: sha, paths: ['docs/x.md'] },
      { id: 'nopaths', commitSha: sha, paths: [] },
      { id: 'nosha', commitSha: null, paths: ['src/a.ts'] },
      { id: 'foreign', commitSha: 'deadbeefdeadbeef', paths: ['src/a.ts'] },
      { id: 'evil', commitSha: '--output=x', paths: ['src/a.ts'] },
    ]

    put(d, 'src/a.ts', '2')
    git(d, 'commit', '-qam', 'two')
    put(d, 'src/b.ts', 'uncommitted')
    rmSync(join(d, 'docs/x.md'))

    const r = await checkStaleness(d, ms)
    expect(r.get('a')).toEqual({ status: 'stale', changedPaths: ['src/a.ts'] })
    expect(r.get('b')?.status).toBe('stale')
    expect(r.get('dir')?.changedPaths.sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(r.get('docs')).toEqual({ status: 'stale', changedPaths: ['docs/x.md'] })
    for (const id of ['nopaths', 'nosha', 'foreign', 'evil']) expect(r.get(id)?.status).toBe('unchecked')
  })

  it('is fresh when nothing named changed, and unchecked outside a git repo', async () => {
    const { d, sha } = repo()
    put(d, 'other.txt', 'x')
    git(d, 'add', '-A')
    git(d, 'commit', '-qm', 'unrelated')
    const ms = [{ id: 'a', commitSha: sha, paths: ['src/a.ts'] }]
    expect((await checkStaleness(d, ms)).get('a')).toEqual({ status: 'fresh', changedPaths: [] })

    const plain = mkdtempSync(join(tmpdir(), 'cairn-plain-'))
    dirs.push(plain)
    expect((await checkStaleness(plain, ms)).get('a')?.status).toBe('unchecked')
  })

  it('treats glob characters in paths literally', async () => {
    const { d, sha } = repo()
    put(d, 'src/a.ts', '2')
    const r = await checkStaleness(d, [{ id: 'g', commitSha: sha, paths: ['src/*.ts'] }])
    expect(r.get('g')?.status).toBe('fresh')
  })
})
