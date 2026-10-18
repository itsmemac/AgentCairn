import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClientError, claudeRegistration, loadClientConfig } from '../src/client.js'

const dir = mkdtempSync(join(tmpdir(), 'cairn-client-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const claudeJson = (servers: unknown) => {
  const file = join(dir, `claude-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(file, JSON.stringify({ mcpServers: servers }))
  return file
}
const registered = claudeJson({ cairn: { type: 'stdio', command: 'npx', env: { CAIRN_URL: 'http://nas:8787/', CAIRN_TOKEN: 'tok' } } })

describe('client config', () => {
  it('reads the address and token from the Claude Code registration', () => {
    expect(claudeRegistration(registered)).toEqual({ url: 'http://nas:8787/', token: 'tok' })
    expect(loadClientConfig(dir, {}, registered)).toEqual({ url: 'http://nas:8787', token: 'tok' })
  })

  it('prefers the environment over the registration', () => {
    const env = { CAIRN_URL: 'http://other:1', CAIRN_TOKEN: 'mine' }
    expect(loadClientConfig(dir, env, registered)).toEqual({ url: 'http://other:1', token: 'mine' })
  })

  it('does not borrow the registration token for a different address', () => {
    expect(loadClientConfig(dir, { CAIRN_URL: 'http://other:1' }, registered).token).toBeUndefined()
  })

  it('still fails clearly with no environment and no registration', () => {
    const none = claudeJson({ other: { env: { CAIRN_URL: 'http://x' } } })
    expect(() => loadClientConfig(dir, {}, none)).toThrow(ClientError)
    expect(() => loadClientConfig(dir, {}, join(dir, 'missing.json'))).toThrow(/CAIRN_URL is not set/)
  })
})
