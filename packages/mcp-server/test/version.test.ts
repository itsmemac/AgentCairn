import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SERVER_VERSION } from '../src/version.js'

describe('server version', () => {
  it('is the package version, so a release can never leave the dashboard on an old number', () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string }
    expect(SERVER_VERSION).toBe(pkg.version)
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
