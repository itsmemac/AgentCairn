import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import {
  type Brain,
  type Principal,
  SOLO_PRINCIPAL,
  type TokenScope,
  type UserRecord,
  countActiveTokens,
  countActiveUsers,
  findApiToken,
  firstAdmin,
  principalOf,
  touchApiToken,
} from '@agentcairn/core'

export type AuthResult =
  | { ok: true; kind: 'env' | 'managed' | 'open'; name: string; principal: Principal }
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
  private readonly good = new Map<string, { id: string; name: string; principal: Principal; until: number }>()
  private readonly bad = new Map<string, number>()
  private readonly touched = new Map<string, number>()
  private managed: { value: boolean; until: number } | undefined
  private solo: { value: boolean; until: number } | undefined

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
    this.solo = undefined
  }

  /** One active user or none: solo mode. Cached briefly; invalidate() refreshes it when users change. */
  private async isSolo(): Promise<boolean> {
    const now = this.clock()
    if (this.solo && this.solo.until > now) return this.solo.value
    const value = (await countActiveUsers(this.brain)) <= 1
    this.solo = { value, until: now + NEGATIVE_MS }
    return value
  }

  /** Who a request acts as. A token acts as its creator; the old shared token and open mode act as the first admin. */
  private async principalFor(user: UserRecord | null, scope: TokenScope | null = null): Promise<Principal | null> {
    const solo = await this.isSolo()
    const acting = user ?? (await firstAdmin(this.brain))
    if (!acting) return scope ? { ...SOLO_PRINCIPAL, scope } : SOLO_PRINCIPAL
    if (acting.status === 'disabled') return null
    const principal = principalOf(acting, solo)
    return scope ? { ...principal, scope } : principal
  }

  private async hasManagedTokens(): Promise<boolean> {
    const now = this.clock()
    if (this.managed && this.managed.until > now) return this.managed.value
    const value = (await countActiveTokens(this.brain)) > 0
    this.managed = { value, until: now + NEGATIVE_MS }
    return value
  }

  async check(req: IncomingMessage): Promise<AuthResult> {
    if (this.options.noAuth) return { ok: true, kind: 'open', name: 'open', principal: (await this.principalFor(null)) ?? SOLO_PRINCIPAL }

    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

    if (bearer && this.options.envToken) {
      const a = digest(bearer)
      const b = digest(this.options.envToken)
      if (timingSafeEqual(a, b)) {
        const principal = await this.principalFor(null)
        if (principal) return { ok: true, kind: 'env', name: 'env', principal }
      }
    }

    if (bearer) {
      const key = createHash('sha256').update(bearer).digest('hex')
      const now = this.clock()
      const cached = this.good.get(key)
      if (cached && cached.until > now) {
        this.touch(cached.id, now)
        return { ok: true, kind: 'managed', name: cached.name, principal: cached.principal }
      }
      if ((this.bad.get(key) ?? 0) > now) return { ok: false, reason: 'invalid' }

      const found = await findApiToken(this.brain, bearer)
      const principal = found ? await this.principalFor(found.user, found.scope) : null
      if (found && principal) {
        this.good.set(key, { id: found.id, name: found.name, principal, until: now + POSITIVE_MS })
        this.touch(found.id, now)
        return { ok: true, kind: 'managed', name: found.name, principal }
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
