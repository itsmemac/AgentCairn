import { readFileSync } from 'node:fs'

/** The CLI's own version, read from its package.json (it sits one folder above dist/). */
export function cliVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
