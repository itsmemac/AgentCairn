import neo4j, { type Driver, type QueryResult, type Session } from 'neo4j-driver'
import type { BrainConfig } from './config.js'

export interface Brain {
  readonly driver: Driver
  readonly database: string | undefined
  session(): Session
  run(cypher: string, params?: Record<string, unknown>): Promise<QueryResult>
  close(): Promise<void>
}

export function openBrain(config: BrainConfig): Brain {
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password))
  const database = config.database
  const session = () => driver.session(database ? { database } : undefined)

  return {
    driver,
    database,
    session,
    async run(cypher, params = {}) {
      const s = session()
      try {
        return await s.run(cypher, params)
      } finally {
        await s.close()
      }
    },
    close: () => driver.close(),
  }
}

export interface ConnectionInfo {
  agent: string
  address: string
}

export async function checkConnection(brain: Brain): Promise<ConnectionInfo> {
  await brain.driver.verifyConnectivity()
  const info = await brain.driver.getServerInfo()
  return { agent: info.agent ?? 'unknown', address: info.address ?? 'unknown' }
}
