import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildSnapshot, captureMode } from '../src/commands/capture.js'
import { resumeChecks } from '../src/commands/hook.js'
import { digestSession } from '../src/transcript.js'

const line = (o: unknown) => JSON.stringify(o)
const at = (n: number) => `2026-10-20T10:${String(n).padStart(2, '0')}:00.000Z`
const prompt = (text: string, n: number) => line({ type: 'user', timestamp: at(n), message: { role: 'user', content: text } })
const reply = (text: string, n: number) => line({ type: 'assistant', timestamp: at(n), message: { role: 'assistant', content: [{ type: 'text', text }] } })
const use = (name: string, input: Record<string, unknown>, n: number) =>
  line({ type: 'assistant', timestamp: at(n), message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } })
const result = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })

describe('digestSession', () => {
  it('collects what the person asked, the files edited, tool counts, the last reply and the time span', () => {
    const d = digestSession(
      [
        prompt('Add the invite page', 1),
        use('Edit', { file_path: '/repo/src/invite.ts' }, 2),
        use('Write', { file_path: '/repo/src/accept.ts' }, 3),
        use('Edit', { file_path: '/repo/src/invite.ts' }, 4),
        use('Bash', { command: 'npm test' }, 5),
        result,
        reply('Started the accept page; tests not written yet.', 6),
        prompt('Also make it work for viewers', 7),
        reply('Done: viewers can accept too.', 8),
      ].join('\n'),
    )
    expect(d.prompts.map(p => p.text)).toEqual(['Add the invite page', 'Also make it work for viewers'])
    expect(d.touched).toEqual(['/repo/src/invite.ts', '/repo/src/accept.ts'])
    expect(d.tools).toEqual({ Edit: 2, Write: 1, Bash: 1 })
    expect(d.lastReply).toBe('Done: viewers can accept too.')
    expect(d.startedAt).toBe(at(1))
    expect(d.endedAt).toBe(at(8))
  })

  it('strips the wrapping Claude Code puts around commands and reminders, and skips what no person typed', () => {
    const d = digestSession(
      [
        prompt('<command-message>cairn</command-message>\n<command-name>/cairn</command-name>\n<command-args>init app</command-args>', 1),
        prompt('Stop hook feedback: You changed files this turn but have not recorded where the work stands.', 2),
        line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta row' } }),
        prompt('Real ask <system-reminder>ignore this</system-reminder> continues', 3),
        line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'a subagent prompt' } }),
        '{"broken',
        '',
      ].join('\n'),
    )
    expect(d.prompts.map(p => p.text)).toEqual(['/cairn init app', 'Real ask continues'])
  })

  it('is empty for an empty transcript', () => {
    expect(digestSession('')).toEqual({ startedAt: null, endedAt: null, prompts: [], touched: [], tools: {}, lastReply: null })
  })
})

describe('captureMode', () => {
  it('records everything unless told otherwise', () => {
    expect(captureMode({})).toBe('full')
    expect(captureMode({ CAIRN_SESSION_CAPTURE: 'META' })).toBe('meta')
    expect(captureMode({ CAIRN_SESSION_CAPTURE: 'off' })).toBe('off')
    expect(captureMode({ CAIRN_SESSION_CAPTURE: 'nonsense' })).toBe('full')
  })
})

describe('snapshots and the repository check, in a real git repository', () => {
  const dirs: string[] = []
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

  function repo(): string {
    const d = mkdtempSync(join(tmpdir(), 'cairn-cap-'))
    dirs.push(d)
    git(d, 'init', '-q', '-b', 'main')
    git(d, 'config', 'user.name', 'Test User')
    writeFileSync(join(d, 'app.ts'), '1')
    git(d, 'add', '-A')
    git(d, 'commit', '-qm', 'first commit')
    return d
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  function transcript(dir: string, lines: string[]): string {
    const file = join(mkdtempSync(join(tmpdir(), 'cairn-tx-')), 'session-abc.jsonl')
    dirs.push(join(file, '..'))
    writeFileSync(file, lines.join('\n'))
    return file
  }

  it('captures words, files, commits and the state of the working tree, with secrets removed', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'wip.ts'), 'half done') // untracked: uncommitted work
    const file = transcript(dir, [
      prompt('Deploy it. The new password is Maccy@2026 and the token aib_rNvYxu2-7lVJz_nGe7tW0Qs5H6jtHvj4.', 1),
      use('Edit', { file_path: join(dir, 'app.ts') }, 2),
      use('Edit', { file_path: join(tmpdir(), 'elsewhere.ts') }, 3),
      reply('Edited app.ts; wip.ts is half done.', 4),
    ])
    const s = (await buildSnapshot({ transcriptPath: file, dir, mode: 'full' }))!
    expect(s.sessionId).toBe('session-abc')
    expect(s).toMatchObject({ agent: 'claude-code', branch: 'main', author: 'Test User', headSubject: 'first commit', touched: ['app.ts'], dirty: ['wip.ts'], lastReply: 'Edited app.ts; wip.ts is half done.' })
    expect(s.head).toBe(git(dir, 'rev-parse', 'HEAD'))
    expect(s.tools).toEqual({ Edit: 2 })
    expect(JSON.stringify(s.prompts)).not.toContain('Maccy@2026')
    expect(JSON.stringify(s.prompts)).not.toContain('aib_rNv')
    expect(s.prompts![0]!.text).toContain('Deploy it.')
  })

  it('meta mode sends no words at all, and off sends nothing', async () => {
    const dir = repo()
    const file = transcript(dir, [prompt('Something private', 1), reply('A reply', 2)])
    const meta = (await buildSnapshot({ transcriptPath: file, dir, mode: 'meta' }))!
    expect(meta.prompts).toEqual([])
    expect(meta.lastReply).toBeUndefined()
    expect(meta.branch).toBe('main')
    expect(await buildSnapshot({ transcriptPath: file, dir, mode: 'off' })).toBeNull()
  })

  it('adds a prompt the transcript does not have yet, once, and keeps the first ask and the latest ones', async () => {
    const dir = repo()
    const asks = Array.from({ length: 12 }, (_, i) => prompt(`ask number ${i}`, i + 1))
    const file = transcript(dir, asks)
    const fresh = (await buildSnapshot({ transcriptPath: file, dir, mode: 'full', prompt: 'a brand new ask' }))!
    const texts = fresh.prompts!.map(p => p.text)
    expect(texts).toHaveLength(7)
    expect(texts[0]).toBe('ask number 0')
    expect(texts.at(-1)).toBe('a brand new ask')
    expect(texts).not.toContain('ask number 4')

    // a prompt that is already the last one is not added twice
    const same = (await buildSnapshot({ transcriptPath: file, dir, mode: 'full', prompt: 'ask number 11' }))!
    expect(same.prompts!.filter(p => p.text === 'ask number 11')).toHaveLength(1)
  })

  it('needs a session id from somewhere, and marks the end of a session', async () => {
    const dir = repo()
    expect(await buildSnapshot({ dir, mode: 'full' })).toBeNull()
    const ended = (await buildSnapshot({ sessionId: 's1', dir, mode: 'full', ended: true, now: new Date('2026-10-20T12:00:00Z') }))!
    expect(ended.endedAt).toBe('2026-10-20T12:00:00.000Z')
  })

  it('tells a fresh machine when the last commit is missing, and what the previous session left behind', async () => {
    const dir = repo()
    const head = git(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'b.ts'), '2')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'second')

    const none = await resumeChecks(dir, null)
    expect(none).toEqual([])

    const missing = await resumeChecks(dir, { handoffId: 'h', topic: 'main', commitSha: 'f'.repeat(40), createdAt: null, machine: 'old-laptop', author: null, session: null })
    expect(missing[0]).toContain('does not have that commit')
    expect(missing[0]).toContain('old-laptop')

    const ahead = await resumeChecks(dir, { handoffId: 'h', topic: 'main', commitSha: head, createdAt: null, machine: 'pc', author: null, session: null })
    expect(ahead).toEqual([`1 commit has been made since the last handoff (${head.slice(0, 7)}).`])

    const moved = await resumeChecks(dir, { handoffId: 'h', topic: 'main', commitSha: head, createdAt: null, machine: 'pc', author: null, paths: ['b.ts', 'untouched.ts'], session: null })
    expect(moved.join('\n')).toContain('1 of the files the last handoff is about changed since it was written (b.ts)')
    const quiet = await resumeChecks(dir, { handoffId: 'h', topic: 'main', commitSha: head, createdAt: null, machine: 'pc', author: null, paths: ['untouched.ts'], session: null })
    expect(quiet.join('\n')).not.toContain('files the last handoff is about')

    const other = await resumeChecks(
      dir,
      { handoffId: null, topic: 'feature', commitSha: null, createdAt: null, machine: null, author: null, session: { id: 's', machine: 'old-laptop', branch: 'feature', head: null, dirty: ['a.ts', 'b.ts'], updatedAt: '2026-10-20T10:00:00Z' } },
      'this-pc',
    )
    expect(other.join('\n')).toContain('branch "feature"')
    expect(other.join('\n')).toContain('lives only on that machine')
    const same = await resumeChecks(dir, { handoffId: null, topic: null, commitSha: null, createdAt: null, machine: null, author: null, session: { id: 's', machine: 'this-pc', branch: null, head: null, dirty: ['a.ts'], updatedAt: '2026-10-20T10:00:00Z' } }, 'this-pc')
    expect(same[0]).toContain('The previous session here left 1 uncommitted file')
  })
})
