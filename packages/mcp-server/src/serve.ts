#!/usr/bin/env node
import { countAdmins, ensureSchema, hasDefaultCredentials, loadConfig, loadEnvironment, openBrain } from '@agentcairn/core'
import { createBrainHttp } from './http.js'
import { setupBanner } from './security.js'

const log = (message: string) => console.error(`cairn: ${message}`)

async function main(): Promise<void> {
  loadEnvironment()
  const env = process.env
  const token = env.CAIRN_TOKEN || undefined
  const noAuth = env.CAIRN_NO_AUTH === '1'
  if (noAuth) log('warning: running WITHOUT authentication (CAIRN_NO_AUTH=1).')

  const config = loadConfig()
  if (hasDefaultCredentials(config)) log('warning: Neo4j is using the default credentials.')
  const brain = openBrain(config)

  const port = Number(env.CAIRN_PORT || 8787)
  const host = env.CAIRN_HOST || '0.0.0.0'
  const { server, setup } = createBrainHttp(brain, {
    token,
    noAuth,
    log,
    port,
    capture: env.CAIRN_CAPTURE === 'meta' ? 'meta' : 'full',
    eventCapacity: Number(env.CAIRN_EVENT_CAPACITY) || undefined,
    trustProxy: env.CAIRN_TRUST_PROXY === '1',
    secureCookies: env.CAIRN_COOKIE_SECURE === '1',
  })

  server.listen(port, host, () => log(`listening on http://${host}:${port} (dashboard /ui/, MCP /mcp, neo4j ${config.uri})`))

  // Neo4j may still be starting; everything here is retried lazily on first use.
  void (async () => {
    try {
      await ensureSchema(brain)
      if (env.CAIRN_RESET_ADMIN === '1') {
        await brain.run('MATCH (a:Admin) DETACH DELETE a')
        await brain.run("MATCH (m:BrainMeta {id: 'setup'}) DELETE m")
        log('CAIRN_RESET_ADMIN=1: all dashboard accounts were removed. Unset it after this start.')
      }
      log('schema ready')
      if ((await countAdmins(brain)) === 0 && !setup.isOpen) console.error(`\n${setupBanner(setup.open(), port)}\n`)
      else if (!token && !noAuth) log('dashboard account exists; create access tokens under Access in the dashboard.')
    } catch (error) {
      log(`schema not ready yet (${(error as Error).message}); will retry on first request`)
    }
  })()

  const shutdown = () => {
    server.close(() => void brain.close().finally(() => process.exit(0)))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(error => {
  log(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
