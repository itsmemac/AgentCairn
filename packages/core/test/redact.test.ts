import { describe, expect, it } from 'vitest'
import { clip, redactSecrets, sanitize } from '../src/redact.js'

describe('redactSecrets', () => {
  const secrets = [
    'aib_rNvYxu2-7lVJz_nGe7tW0Qs5H6jtHvj4',
    'npm_2CcEabcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
  ]

  it('removes well-known token shapes wherever they appear', () => {
    for (const secret of secrets) {
      const out = redactSecrets(`please use ${secret} for the deploy`)
      expect(out, secret).not.toContain(secret)
      expect(out).toContain('[redacted]')
      expect(out).toContain('please use')
    }
  })

  it('removes passwords that are stated in a sentence or assigned', () => {
    expect(redactSecrets('the new password is Maccy@2026, thanks')).not.toContain('Maccy@2026')
    expect(redactSecrets('NEO4J_PASSWORD=hunter2hunter2')).toBe('NEO4J_PASSWORD=[redacted]')
    expect(redactSecrets('{"apiKey": "abcd1234efgh"}')).not.toContain('abcd1234efgh')
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop1234')).toBe('Authorization: Bearer [redacted]')
    expect(redactSecrets('postgres://admin:s3cr3tpass@db.local/app')).toBe('postgres://[redacted]@db.local/app')
  })

  it('removes private keys, including a truncated one', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----'
    expect(redactSecrets(`here: ${key} done`)).toBe('here: [redacted private key] done')
    expect(redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIE')).toBe('[redacted private key]')
  })

  it('leaves ordinary prose, code and short values alone', () => {
    const plain = 'Rename the token field to accessToken and update the password policy docs. See src/auth.ts:42.'
    expect(redactSecrets(plain)).toBe(plain)
    expect(redactSecrets('set secret=1')).toBe('set secret=1')
  })

  it('is idempotent', () => {
    const once = redactSecrets('password is hunter2hunter2 and aib_rNvYxu2-7lVJz_nGe7tW0Qs5H6jtHvj4')
    expect(redactSecrets(once)).toBe(once)
  })
})

describe('clip and sanitize', () => {
  it('shortens with an ellipsis and trims', () => {
    expect(clip('  hello world  ', 20)).toBe('hello world')
    expect(clip('abcdefghij', 5)).toBe('abcd…')
  })
  it('redacts before shortening, so a cut can never expose half a secret', () => {
    const out = sanitize(`x ${'a'.repeat(5)} aib_rNvYxu2-7lVJz_nGe7tW0Qs5H6jtHvj4`, 14)
    expect(out).not.toMatch(/aib_/)
  })
})
