#!/usr/bin/env node
import { loadConfig, loadEnvironment, openBrain } from '@agentcairn/core'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createBrainServer } from './server.js'

async function main(): Promise<void> {
  const cwd = process.cwd()
  loadEnvironment(cwd)
  const brain = openBrain(loadConfig())
  const server = createBrainServer(brain, cwd)

  const shutdown = async () => {
    await server.close().catch(() => undefined)
    await brain.close().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // stdout carries the protocol: log to stderr only.
  await server.connect(new StdioServerTransport())
  console.error(`cairn: ready (folder ${cwd})`)
}

main().catch(error => {
  console.error('cairn: failed to start:', error)
  process.exit(1)
})
