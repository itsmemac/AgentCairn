import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { header } from './util.js'

// ---- sessions --------------------------------------------------------------

export const SESSION_COOKIE = 'aib_session'
const SESSION_MS = 12 * 60 * 60 * 1000

export interface Session {
  username: string
  expires: number
}

/** Dashboard logins live in memory: a restart signs everyone out, which is fine for an admin panel. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly clock: () => number = Date.now) {}

  create(username: string): { id: string; maxAgeSeconds: number } {
    const id = randomBytes(32).toString('base64url')
    this.sessions.set(id, { username, expires: this.clock() + SESSION_MS })
    for (const [k, s] of this.sessions) if (s.expires < this.clock()) this.sessions.delete(k)
    return { id, maxAgeSeconds: SESSION_MS / 1000 }
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined
    const s = this.sessions.get(id)
    if (!s) return undefined
    if (s.expires < this.clock()) {
      this.sessions.delete(id)
      return undefined
    }
    return s
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id)
  }

  clear(): void {
    this.sessions.clear()
  }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function sessionCookie(id: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

export const clearedSessionCookie = (secure: boolean) =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`

/** A cross-site page must not be able to drive the dashboard with the admin's cookie. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = header(req, 'origin')
  if (!origin) return true
  try {
    return new URL(origin).host === header(req, 'host')
  } catch {
    return false
  }
}

// ---- rate limiting ---------------------------------------------------------

/** Fixed-window limiter for login and setup-code guesses. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Records an attempt; returns false once the key is over the limit. */
  attempt(key: string): boolean {
    const now = this.clock()
    for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k)
    const entry = this.hits.get(key) ?? { count: 0, resetAt: now + this.windowMs }
    entry.count++
    this.hits.set(key, entry)
    return entry.count <= this.max
  }

  reset(key: string): void {
    this.hits.delete(key)
  }

  retryAfterSeconds(key: string): number {
    const e = this.hits.get(key)
    return e ? Math.max(1, Math.ceil((e.resetAt - this.clock()) / 1000)) : 0
  }
}

// ---- one-time setup code ---------------------------------------------------

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export function generateSetupCode(): string {
  const bytes = randomBytes(12)
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]!).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`
}

const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * The passcode printed in the startup log while no admin exists. It lives
 * only in memory: a restart prints a new one, and creating the admin ends it.
 */
export class SetupGate {
  private code: string | null = null

  open(): string {
    this.code = generateSetupCode()
    return this.code
  }

  close(): void {
    this.code = null
  }

  get isOpen(): boolean {
    return this.code !== null
  }

  check(given: string): boolean {
    if (!this.code) return false
    const a = Buffer.from(normalizeCode(given).padEnd(32, '_'))
    const b = Buffer.from(normalizeCode(this.code).padEnd(32, '_'))
    return a.length === b.length && timingSafeEqual(a, b) && normalizeCode(given).length === 12
  }
}

export function setupBanner(code: string, port: number): string {
  const lines = [
    'Agent Cairn: first-time setup',
    '',
    `Open  http://<this-server>:${port}/ui/  and enter this one-time code:`,
    '',
    `        ${code}`,
    '',
    'It works until the admin account is created, or the server restarts.',
  ]
  const width = Math.max(...lines.map(l => l.length)) + 4
  const bar = '─'.repeat(width)
  return ['┌' + bar + '┐', ...lines.map(l => `│  ${l.padEnd(width - 2)}│`), '└' + bar + '┘'].join('\n')
}
