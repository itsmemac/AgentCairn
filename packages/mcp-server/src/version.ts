import { readFileSync } from 'node:fs'

/** The package's own version, so it can never drift from what was released. */
export const SERVER_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
