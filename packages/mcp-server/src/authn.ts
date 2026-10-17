import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { type Brain, countActiveTokens, findApiToken, touchApiToken } from '@agentcairn/core'

export type AuthResult =
  | { ok: true; kind: 'env' | 'managed' | 'open'; name: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'no_tokens' }

export interface AuthOptions {
  /** A static token from the environment (CAIRN_TOKEN). */
  envToken?: string
  /** Explicit opt-in to no authentication at all. */
  noAuth?: boolean
}

const digest = (s: string) => createHash('sha256').update(s).digest()
const POSITIVE_MS = 30_000
const NEGATIVE_MS = 5_000
const TOUCH_MS = 60_000

/**
 * Checks bearer tokens for the machine-facing endpoints: the static
 * environment token, or tokens created in the dashboard (stored hashed).
 * Lookups are cached briefly so a busy agent does not hit the database on
 * every call; `invalidate()` makes revocations take effect at once.
 */
export class Authenticator {
  private readonly good = new Map<string, { id: string; name: string; until: number }>()
  private readonly bad = new Map<string, number>()
  private readonly touched = new Map<string, number>()
  private managed: { value: boolean; until: number } | undefined

  constructor(
    private readonly brain: Brain,
    private readonly options: AuthOptions = {},
    private readonly clock: () => number = Date.now,
    private readonly log: (m: string) => void = () => undefined,
  ) {}

  invalidate(): void {
    this.good.clear()
    this.bad.clear()
    this.managed = undefined
  }

  private async hasManagedTokens(): Promise<boolean> {
    const now = this.clock()
    if (this.managed && this.managed.until > now) return this.managed.value
    const value = (await countActiveTokens(this.brain)) > 0
    this.managed = { value, until: now + NEGATIVE_MS }
    return value
  }

  async check(req: IncomingMessage): Promise<AuthResult> {
    if (this.options.noAuth) return { ok: true, kind: 'open', name: 'open' }

    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

    if (bearer && this.options.envToken) {
      const a = digest(bearer)
      const b = digest(this.options.envToken)
      if (timingSafeEqual(a, b)) return { ok: true, kind: 'env', name: 'env' }
    }

    if (bearer) {
      const key = createHash('sha256').update(bearer).digest('hex')
      const now = this.clock()
      const cached = this.good.get(key)
      if (cached && cached.until > now) {
        this.touch(cached.id, now)
        return { ok: true, kind: 'managed', name: cached.name }
      }
      if ((this.bad.get(key) ?? 0) > now) return { ok: false, reason: 'invalid' }

      const found = await findApiToken(this.brain, bearer)
      if (found) {
        this.good.set(key, { ...found, until: now + POSITIVE_MS })
        this.touch(found.id, now)
        return { ok: true, kind: 'managed', name: found.name }
      }
      if (this.bad.size > 500) this.bad.clear()
      this.bad.set(key, now + NEGATIVE_MS)
    }

    if (!this.options.envToken && !(await this.hasManagedTokens())) return { ok: false, reason: 'no_tokens' }
    return { ok: false, reason: bearer ? 'invalid' : 'missing' }
  }

  private touch(id: string, now: number): void {
    if ((this.touched.get(id) ?? 0) + TOUCH_MS > now) return
    this.touched.set(id, now)
    void touchApiToken(this.brain, id).catch(error => this.log(`could not record token use: ${(error as Error).message}`))
  }
}

export const authFailureMessage = (reason: 'missing' | 'invalid' | 'no_tokens'): string =>
  reason === 'no_tokens'
    ? 'No access tokens exist yet. Open the dashboard (/ui/) and create one.'
    : 'Missing or invalid bearer token.'
