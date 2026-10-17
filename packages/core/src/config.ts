import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface BrainConfig {
  uri: string
  user: string
  password: string
  database?: string
}

/**
 * Loads settings from the first env file found, never overriding real
 * environment variables: `CAIRN_ENV_FILE`, then `.env` in `cwd`, then
 * `~/.cairn/.env` (one place to configure every project). Returns the file
 * loaded, if any.
 */
export function loadEnvironment(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    env.CAIRN_ENV_FILE,
    join(cwd, '.env'),
    join(homedir(), '.cairn', '.env'),
  ].filter((p): p is string => Boolean(p))

  const file = candidates.find(existsSync)
  if (!file) return []
  try {
    process.loadEnvFile(file)
  } catch {
    return []
  }
  return [file]
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  return {
    uri: env.NEO4J_URI || 'bolt://localhost:7687',
    user: env.NEO4J_USER || 'neo4j',
    password: env.NEO4J_PASSWORD || 'neo4j',
    database: env.NEO4J_DATABASE || undefined,
  }
}

export function hasDefaultCredentials(config: BrainConfig): boolean {
  return config.user === 'neo4j' && config.password === 'neo4j'
}
