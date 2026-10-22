import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { INIT_TOOL, addLocalTools, handleLine, runLocalInit } from '../src/commands/mcpProxy.js'
import { cliVersion } from '../src/version.js'

const config = { url: 'http://cairn.test', token: 'tok' }
const dirs: string[] = []
const folder = () => {
  const d = mkdtempSync(join(tmpdir(), 'cairn-local-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

describe('the local cairn_init tool', () => {
  it('is added to the server tool list once, and nothing else is touched', () => {
    const list = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'cairn_status' }] } }
    const once = addLocalTools([list])
    const names = (once[0] as typeof list).result.tools.map(t => t.name)
    expect(names).toEqual(['cairn_status', INIT_TOOL.name])
    expect(addLocalTools(once)).toEqual(once)
    const other = { jsonrpc: '2.0', id: 2, result: { content: [] } }
    expect(addLocalTools([other])).toEqual([other])
  })

  it('sets the folder up where the conversation already is, and reports what it did', async () => {
    const dir = folder()
    const calls: unknown[][] = []
    const out = await runLocalInit({ project: 'my-app' }, dir, async (project, flags, cwd, say) => {
      calls.push([project, flags, cwd])
      say('Linked to project "my-app".')
    })
    expect(out.isError).toBe(false)
    expect(out.text).toContain('Linked to project "my-app".')
    expect(out.text).toContain('hooks')
    expect(calls[0]).toEqual(['my-app', { create: true, forceRemote: false, personal: false, noClaude: false, local: false }, dir])
    expect((await runLocalInit({ create: false }, dir, async (_p, flags) => void calls.push([flags.create]))).isError).toBe(false)
    expect(calls[1]).toEqual([false])
  })

  it('says what went wrong instead of throwing', async () => {
    const out = await runLocalInit({}, folder(), async () => {
      throw new Error('This folder has no git remote to identify it.')
    })
    expect(out).toMatchObject({ isError: true })
    expect(out.text).toContain('Could not set this folder up: This folder has no git remote')
  })

  it('answers the call itself, picks up the new link, and forwards everything else', async () => {
    const dir = folder()
    const state = { config, hint: {}, cwd: dir }
    const call = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'cairn_init', arguments: { project: 'x' } } })
    const answers = await handleLine(call, state, {
      fetch: (async () => {
        throw new Error('a local tool must not reach the server')
      }) as unknown as typeof fetch,
      init: async (_p, _f, cwd) => {
        writeFileSync(join(cwd, '.cairn.json'), JSON.stringify({ projectId: 'prj_abc123def456' }))
      },
    })
    const answer = answers[0] as { id: number; result: { isError: boolean; content: { text: string }[] } }
    expect(answer.id).toBe(7)
    expect(answer.result.isError).toBe(false)
    expect(readFileSync(join(dir, '.cairn.json'), 'utf8')).toContain('prj_abc123def456')
    expect(state.hint).toMatchObject({ projectId: 'prj_abc123def456' })

    const list = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }), state, { fetch: reply({ jsonrpc: '2.0', id: 8, result: { tools: [{ name: 'cairn_status' }] } }) })
    expect(JSON.stringify(list)).toContain('cairn_init')
    const status = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'cairn_status' } }), state, { fetch: reply({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: 'ok' }] } }) })
    expect(JSON.stringify(status)).toContain('"ok"')
  })
})

describe('cairn --version', () => {
  it('prints the version of the package', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(cliVersion()).toBe(pkg.version)
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
