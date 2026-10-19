import { describe, expect, it } from 'vitest'
import {
  ConfigFileError,
  cairnCommandFile,
  mayWriteCommand,
  MD_END,
  MD_START,
  hasClaudeMdBlock,
  inspectHooks,
  inspectMcpConfig,
  mcpEntry,
  mergeHooks,
  mergeMcpConfig,
  upsertClaudeMd,
} from '../src/claude.js'
import { analyzeTurn } from '../src/transcript.js'

const CLI = 'node "C:/x/cairn/dist/bin.js"'

describe('mcp config', () => {
  it('writes an http entry that keeps URL and token in the environment', () => {
    const entry = mcpEntry({ projectId: 'my-proj' }) as { url: string; headers: Record<string, string> }
    expect(entry.url).toBe('${CAIRN_URL}/mcp')
    expect(entry.headers).toEqual({ Authorization: 'Bearer ${CAIRN_TOKEN}', 'X-Cairn-Project': 'my-proj' })
  })

  it('falls back to the remote header and refuses to guess', () => {
    expect((mcpEntry({ remote: 'github.com/a/b' }) as { headers: Record<string, string> }).headers['X-Cairn-Remote']).toBe('github.com/a/b')
    expect(() => mcpEntry({})).toThrow()
  })

  it('preserves other servers and keys, and is idempotent', () => {
    const existing = JSON.stringify({ extra: 1, mcpServers: { other: { command: 'x' } } })
    const once = mergeMcpConfig(existing, { projectId: 'p' })
    const parsed = JSON.parse(once)
    expect(parsed.extra).toBe(1)
    expect(parsed.mcpServers.other).toEqual({ command: 'x' })
    expect(parsed.mcpServers['cairn'].headers['X-Cairn-Project']).toBe('p')
    expect(mergeMcpConfig(once, { projectId: 'p' })).toBe(once)
    expect(JSON.parse(mergeMcpConfig(once, { projectId: 'q' })).mcpServers['cairn'].headers['X-Cairn-Project']).toBe('q')
  })

  it('creates from nothing and refuses to overwrite a broken file', () => {
    expect(JSON.parse(mergeMcpConfig(null, { projectId: 'p' })).mcpServers['cairn']).toBeDefined()
    expect(() => mergeMcpConfig('{oops', { projectId: 'p' })).toThrow(ConfigFileError)
    expect(() => mergeMcpConfig('[]', { projectId: 'p' })).toThrow(ConfigFileError)
  })

  it('inspects what is configured', () => {
    expect(inspectMcpConfig(null)).toEqual({ present: false })
    expect(inspectMcpConfig('{oops')).toEqual({ present: false })
    expect(inspectMcpConfig(mergeMcpConfig(null, { projectId: 'p' }))).toEqual({ present: true, projectId: 'p', remote: undefined })
  })
})

describe('hooks', () => {
  it('adds the hooks and keeps everyone else’s', () => {
    const mine = { type: 'command', command: 'echo mine' }
    const existing = JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      hooks: { Stop: [{ hooks: [mine] }], PostToolUse: [{ matcher: 'Edit', hooks: [mine] }] },
    })
    const parsed = JSON.parse(mergeHooks(existing, CLI))
    expect(parsed.permissions).toEqual({ allow: ['Bash(ls)'] })
    expect(parsed.hooks.PostToolUse).toEqual([{ matcher: 'Edit', hooks: [mine] }])
    expect(parsed.hooks.Stop).toHaveLength(2)
    expect(parsed.hooks.Stop[0].hooks[0]).toEqual(mine)
    expect(parsed.hooks.Stop[1].hooks[0].command).toBe(`${CLI} hook stop`)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(`${CLI} hook session-start`)
    expect(parsed.hooks.PreToolUse[0].matcher).toBe(
      'mcp__cairn__cairn_remember|mcp__cairn__cairn_checkpoint|mcp__cairn__cairn_handoff|mcp__cairn__cairn_resume',
    )
    // the conversation is recorded as it goes, not only when it ends
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe(`${CLI} hook user-prompt`)
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toBe(`${CLI} hook pre-compact`)
    expect(parsed.hooks.SessionEnd[0].hooks[0].command).toBe(`${CLI} hook session-end`)
  })

  it('is idempotent and swaps an old command for a new one', () => {
    const once = mergeHooks(null, CLI)
    expect(mergeHooks(once, CLI)).toBe(once)
    const moved = JSON.parse(mergeHooks(once, 'npx -y agentcairn'))
    expect(moved.hooks.Stop).toHaveLength(1)
    expect(moved.hooks.Stop[0].hooks[0].command).toBe('npx -y agentcairn hook stop')
  })

  it('inspects across files', () => {
    expect(inspectHooks(null, null)).toEqual({ sessionStart: false, stop: false, preToolUse: false, capture: false })
    const full = mergeHooks(null, CLI)
    expect(inspectHooks(null, full)).toEqual({ sessionStart: true, stop: true, preToolUse: true, capture: true })
    // an install from before session capture has the three original hooks but not the capture ones
    const original = JSON.parse(full)
    delete original.hooks.UserPromptSubmit
    delete original.hooks.SessionEnd
    delete original.hooks.PreCompact
    expect(inspectHooks(JSON.stringify(original))).toEqual({ sessionStart: true, stop: true, preToolUse: true, capture: false })
    expect(inspectHooks('{oops', full).stop).toBe(true)
  })
})

describe('CLAUDE.md', () => {
  it('creates, appends, replaces in place and is idempotent', () => {
    const created = upsertClaudeMd(null)
    expect(created).toContain(MD_START)
    expect(created).toContain('cairn_checkpoint')
    expect(hasClaudeMdBlock(created)).toBe(true)
    expect(hasClaudeMdBlock('# Title')).toBe(false)

    const appended = upsertClaudeMd('# Project\n\nNotes.\n')
    expect(appended.startsWith('# Project\n\nNotes.\n\n')).toBe(true)
    expect(upsertClaudeMd(appended)).toBe(appended)

    const edited = appended.replace('cairn_checkpoint', 'CHANGED').replace('Notes.', 'Better notes.')
    const refreshed = upsertClaudeMd(edited)
    expect(refreshed).toContain('Better notes.')
    expect(refreshed).not.toContain('CHANGED')
    expect(refreshed.split(MD_START)).toHaveLength(2)
    expect(refreshed.split(MD_END)).toHaveLength(2)
  })
})

describe('analyzeTurn', () => {
  const line = (o: unknown) => JSON.stringify(o)
  const prompt = (text: string) => line({ type: 'user', message: { role: 'user', content: text } })
  const toolResult = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })
  const use = (name: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name }] } })

  it('counts edits since the last prompt and ignores tool results as prompts', () => {
    const t = [prompt('old'), use('Edit'), use('Edit'), prompt('new'), use('Write'), toolResult, use('Bash'), use('MultiEdit')].join('\n')
    expect(analyzeTurn(t)).toEqual({ edits: 2, checkpointed: false, handedOff: false })
  })

  it('sees a checkpoint in this turn but not one from an earlier turn', () => {
    const thisTurn = [prompt('go'), use('Edit'), use('mcp__cairn__cairn_checkpoint')].join('\n')
    expect(analyzeTurn(thisTurn).checkpointed).toBe(true)
    const earlier = [prompt('a'), use('mcp__cairn__cairn_checkpoint'), prompt('b'), use('Edit')].join('\n')
    expect(analyzeTurn(earlier)).toEqual({ edits: 1, checkpointed: false, handedOff: false })
  })

  it('counts a handoff as recording where the work stands', () => {
    const t = [prompt('go'), use('Edit'), use('mcp__cairn__cairn_handoff')].join('\n')
    expect(analyzeTurn(t)).toMatchObject({ checkpointed: false, handedOff: true })
    expect(analyzeTurn([prompt('a'), use('mcp__cairn__cairn_handoff'), prompt('b'), use('Edit')].join('\n')).handedOff).toBe(false)
  })

  it('accepts array-form prompts, skips sidechains and meta rows, tolerates junk', () => {
    const arrayPrompt = line({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })
    const side = line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Edit' }] } })
    const meta = line({ type: 'user', isMeta: true, message: { content: 'system reminder' } })
    const t = ['not json', arrayPrompt, use('Edit'), side, meta, '', '{"type":'].join('\n')
    expect(analyzeTurn(t)).toEqual({ edits: 1, checkpointed: false, handedOff: false })
    expect(analyzeTurn('')).toEqual({ edits: 0, checkpointed: false, handedOff: false })
  })
})

describe('/cairn slash command', () => {
  it('runs the CLI with the typed arguments and allows only that tool', () => {
    const file = cairnCommandFile('npx -y agentcairn')
    expect(file).toContain('allowed-tools: Bash(npx:*)')
    expect(file).toContain('!`npx -y agentcairn $ARGUMENTS 2>&1 || true`')
    expect(cairnCommandFile(CLI)).toContain('allowed-tools: Bash(node:*)')
  })

  it('refreshes its own file but never one written by hand', () => {
    expect(mayWriteCommand(null)).toBe(true)
    expect(mayWriteCommand(cairnCommandFile(CLI))).toBe(true)
    expect(mayWriteCommand('my own /cairn command')).toBe(false)
  })
})
