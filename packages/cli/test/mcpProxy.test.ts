import { describe, expect, it } from 'vitest'
import { forwardMessage, parseMessages, proxyHeaders } from '../src/commands/mcpProxy.js'

const config = { url: 'http://cairn.test', token: 'tok' }
const reply = (body: string, type = 'application/json', status = 200) => async () =>
  new Response(body, { status, headers: { 'content-type': type } })
const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

describe('cairn mcp proxy', () => {
  it('sends the token and the folder identity, preferring the project id', () => {
    expect(proxyHeaders(config, { projectId: 'p', remote: 'github.com/a/b' })).toMatchObject({
      authorization: 'Bearer tok',
      'x-cairn-project': 'p',
    })
    const byRemote = proxyHeaders(config, { remote: 'github.com/a/b' })
    expect(byRemote['x-cairn-remote']).toBe('github.com/a/b')
    expect(byRemote['x-cairn-project']).toBeUndefined()
  })

  it('reads plain JSON and SSE responses', () => {
    expect(parseMessages('application/json', '{"id":1}')).toEqual([{ id: 1 }])
    expect(parseMessages('text/event-stream', 'event: message\ndata: {"id":1}\n\n')).toEqual([{ id: 1 }])
    expect(parseMessages('application/json', '')).toEqual([])
  })

  it('forwards a request and returns the server reply', async () => {
    const out = await forwardMessage(request, config, {}, reply('{"jsonrpc":"2.0","id":1,"result":{}}') as typeof fetch)
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
  })

  it('turns an unreachable server or a bad token into a JSON-RPC error for requests only', async () => {
    const down = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    expect(await forwardMessage(request, config, {}, down)).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32000, message: expect.stringContaining('Cannot reach') } },
    ])
    const denied = await forwardMessage(request, config, {}, reply('', 'text/plain', 401) as typeof fetch)
    expect(denied[0]).toMatchObject({ id: 1, error: { message: expect.stringContaining('token') } })
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(await forwardMessage(notification, config, {}, down)).toEqual([])
  })
})
