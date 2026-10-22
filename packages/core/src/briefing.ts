import type { Brain } from './db.js'
import { MAX_RECALL_LIMIT, MEMORY_KINDS, type Memory, type MemoryKind, recall } from './memory.js'
import { onboardingPrompt } from './onboarding.js'
import { clip } from './redact.js'
import { type SessionRecord, listSessions } from './sessions.js'
import { type Staleness, checkStaleness } from './staleness.js'

export const DEFAULT_BRIEFING_TOKENS = 1500
export const MIN_BRIEFING_TOKENS = 200
export const MAX_BRIEFING_TOKENS = 8000

const MAX_BODY_CHARS = 500
const MIN_BODY_CHARS = 120

/** Cheap token estimate (~4 characters per token); no tokenizer dependency. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

interface Section {
  kind: MemoryKind
  title: string
  /** Share of the budget; what a section leaves unused flows to the next. */
  share: number
  max: number
  /** Rank by recency alone (a log, not a fact). */
  recencyOnly?: boolean
}

// Handoffs and sessions are not listed here: they come first, in their own sections, so a briefing
// opens with where the work was left.
const SECTIONS: readonly Section[] = [
  { kind: 'overview', title: 'Overview', share: 0.25, max: 4 },
  { kind: 'convention', title: 'Conventions', share: 0.15, max: 8 },
  { kind: 'gotcha', title: 'Gotchas', share: 0.15, max: 8 },
  { kind: 'thread', title: 'Open threads', share: 0.1, max: 6 },
  { kind: 'checkpoint', title: 'Recent checkpoints', share: 0.15, max: 3, recencyOnly: true },
  { kind: 'decision', title: 'Decisions', share: 0.15, max: 8 },
  { kind: 'glossary', title: 'Glossary', share: 0.05, max: 10 },
]

/** What a client needs to tell whether the repository it is in matches where the last work stopped. */
export interface ResumeInfo {
  handoffId: string | null
  topic: string | null
  commitSha: string | null
  createdAt: string | null
  machine: string | null
  author: string | null
  /** The files the handoff says it is about, so the client can see which changed since it was written. */
  paths?: string[]
  session: {
    id: string
    machine: string | null
    branch: string | null
    head: string | null
    dirty: string[]
    updatedAt: string
  } | null
}

export interface BriefingOptions {
  maxTokens?: number
  /** Repo folder used to detect stale memories; omit to skip the check. */
  cwd?: string
  /** Staleness computed elsewhere (a remote server cannot see the repo); wins over `cwd`. */
  staleness?: ReadonlyMap<string, Staleness>
  /** Recent sessions to show. `buildBriefing` loads them when omitted. */
  sessions?: readonly SessionRecord[]
  /** What to call the project in the onboarding text, when its id is only a placeholder. */
  label?: string
  /** For tests. */
  now?: Date
}

export interface Briefing {
  projectId: string
  /** `empty` means the text is the onboarding prompt. */
  status: 'ready' | 'empty'
  text: string
  tokens: number
  includedIds: string[]
  staleIds: string[]
  /** Active memories that did not fit. Fetch them with recall. */
  omitted: number
  /** Where the last work stopped, for a client that can check the repository. */
  resume: ResumeInfo | null
}

export const shortId = (id: string) => id.slice(0, 8)

const ageDays = (m: Memory, now: Date) => Math.max(0, (now.getTime() - Date.parse(m.createdAt)) / 86_400_000)

function score(m: Memory, section: Section, stale: boolean, now: Date): number {
  const recency = 2 * Math.exp(-ageDays(m, now) / 30)
  if (section.recencyOnly) return recency
  return m.importance * 2 + recency - (stale ? 1.5 : 0)
}

/** A memory whose `review_by` day has come: it was true when written, and nobody has checked since. */
const reviewDue = (m: Memory, now: Date) => Boolean(m.reviewBy) && m.reviewBy! <= now.toISOString().slice(0, 10)

function render(m: Memory, stale: Staleness | undefined, bodyChars: number, now: Date): string {
  const body = m.body.replace(/\s+/g, ' ').trim()
  const clipped = body.length > bodyChars ? `${body.slice(0, bodyChars - 1).trimEnd()}…` : body
  const area = m.area ? ` [${m.area}]` : ''
  const flag =
    stale?.status === 'stale' ? ` ⚠ may be stale (changed: ${stale.changedPaths.slice(0, 2).join(', ')})` : ''
  const due = reviewDue(m, now) ? ` ⚠ review was due ${m.reviewBy}` : ''
  const revisit = m.revisitWhen ? ` (revisit when: ${m.revisitWhen.replace(/\s+/g, ' ').slice(0, 120)})` : ''
  return `- **${m.title}**${area} #${shortId(m.id)}: ${clipped}${revisit}${flag}${due}`
}

/** A handoff keeps its structure (headings and lists): the next steps matter more than how tidy it is, so it is cut from the end. */
export function renderHandoffLine(m: Memory, maxChars: number): string {
  const meta = [m.topic, m.createdAt.slice(0, 10), m.machine ?? m.author].filter(Boolean).join(', ')
  let out = `- **${m.title}** (${meta}) #${shortId(m.id)}`
  for (const line of m.body.split('\n').filter(l => l.trim() !== '')) {
    const next = `${out}\n  ${line}`
    if (next.length > maxChars) return `${out}\n  …`
    out = next
  }
  return out
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`

/** One session as a few lines: who and where, what was asked, what the agent last said, what changed. */
export function renderSessionLine(s: SessionRecord, maxChars: number): string {
  const where = [s.machine ?? 'unknown machine', s.agent ? `(${s.agent})` : '', s.branch ? `· ${s.branch}` : '', s.head ? `@ ${s.head.slice(0, 7)}` : '']
    .filter(Boolean)
    .join(' ')
  const lines = [`- ${when(s.updatedAt)} · ${where}`]
  const asked = s.prompts[0]
  const latest = s.prompts.length > 1 ? s.prompts[s.prompts.length - 1] : undefined
  if (asked) lines.push(`  asked: "${clip(asked.text.replace(/\s+/g, ' '), 220)}"`)
  if (latest) lines.push(`  latest ask: "${clip(latest.text.replace(/\s+/g, ' '), 220)}"`)
  if (s.lastReply) lines.push(`  last reply: "${clip(s.lastReply.replace(/\s+/g, ' '), 320)}"`)
  if (s.touched.length) lines.push(`  edited: ${s.touched.slice(0, 6).join(', ')}${s.touched.length > 6 ? ` (+${s.touched.length - 6} more)` : ''}`)
  if (s.commits.length) lines.push(`  committed: ${s.commits.slice(0, 3).join('; ')}${s.commits.length > 3 ? ` (+${s.commits.length - 3} more)` : ''}`)
  if (s.dirty.length) lines.push(`  uncommitted: ${s.dirty.slice(0, 6).join(', ')}${s.dirty.length > 6 ? ` (+${s.dirty.length - 6} more)` : ''}`)
  let out = ''
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line
    if (next.length > maxChars) return `${out}\n  …`
    out = next
  }
  return out
}

/** Fits as many items as the budget allows, each rendered as long as possible then shorter. */
function fit<T>(items: readonly T[], budgetTokens: number, renderAt: (item: T, chars: number) => string, sizes: readonly number[]): { item: T; line: string }[] {
  const out: { item: T; line: string }[] = []
  let left = budgetTokens
  for (const item of items) {
    for (const chars of sizes) {
      const line = renderAt(item, chars)
      const cost = estimateTokens(line) + 1
      if (cost <= left) {
        out.push({ item, line })
        left -= cost
        break
      }
    }
  }
  return out
}

const HANDOFF_SIZES = [2200, 1200, 600, 300] as const
const SESSION_SIZES = [900, 500, 260] as const

function resumeInfo(handoffs: readonly Memory[], sessions: readonly SessionRecord[]): ResumeInfo | null {
  const h = handoffs[0]
  const s = sessions[0]
  if (!h && !s) return null
  return {
    handoffId: h?.id ?? null,
    topic: h?.topic ?? null,
    commitSha: h?.commitSha ?? null,
    createdAt: h?.createdAt ?? null,
    machine: h?.machine ?? null,
    author: h?.author ?? null,
    paths: h?.paths ?? [],
    session: s ? { id: s.id, machine: s.machine, branch: s.branch, head: s.head, dirty: s.dirty, updatedAt: s.updatedAt } : null,
  }
}

/**
 * Pure assembly of a briefing from already-loaded memories. It opens with where the work was left (the
 * latest handoffs and sessions), then the sections follow a fixed priority, each getting a share of the
 * budget plus whatever earlier ones left, and items are picked by score (importance, recency, minus
 * staleness). An item that does not fit is shortened once, then skipped.
 */
export function assembleBriefing(
  projectId: string,
  memories: readonly Memory[],
  staleness: ReadonlyMap<string, Staleness>,
  totalByKind: ReadonlyMap<MemoryKind, number>,
  options: Pick<BriefingOptions, 'maxTokens' | 'now' | 'sessions'> = {},
): Briefing {
  const max = Math.min(Math.max(options.maxTokens ?? DEFAULT_BRIEFING_TOKENS, MIN_BRIEFING_TOKENS), MAX_BRIEFING_TOKENS)
  const now = options.now ?? new Date()
  const isStale = (m: Memory) => staleness.get(m.id)?.status === 'stale'

  const active = memories.filter(m => m.status === 'active')
  const staleIds = active.filter(m => isStale(m) || reviewDue(m, now)).map(m => m.id)
  const lastCheckpoint = active
    .filter(m => m.kind === 'checkpoint')
    .map(m => m.createdAt)
    .sort()
    .at(-1)

  const handoffs = active
    .filter(m => m.kind === 'handoff')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2)
  const sessions = (options.sessions ?? []).slice(0, 3)

  const header = [
    `# Brain briefing: ${projectId}`,
    `${[...totalByKind.values()].reduce((a, b) => a + b, 0)} active memories. Last checkpoint: ${
      lastCheckpoint ? lastCheckpoint.slice(0, 10) : 'none'
    }.`,
    ...(staleIds.length ? [`⚠ ${staleIds.length} memories may be stale (files changed since they were written, or their review date has passed): verify before relying on them.`] : []),
  ].join('\n')

  const footerReserve = 60
  let remaining = max - estimateTokens(header) - footerReserve

  // where the work was left comes first, with its own budget
  const handoffShown = fit(handoffs, Math.min(remaining, Math.floor(max * 0.3)), (m, chars) => renderHandoffLine(m, chars), HANDOFF_SIZES)
  remaining -= handoffShown.reduce((n, h) => n + estimateTokens(h.line) + 1, 0) + (handoffShown.length ? estimateTokens('\n## Where we left off\n') : 0)
  const sessionsShown = fit(sessions, Math.min(Math.max(remaining, 0), Math.floor(max * 0.16)), (s, chars) => renderSessionLine(s, chars), SESSION_SIZES)
  remaining -= sessionsShown.reduce((n, s) => n + estimateTokens(s.line) + 1, 0) + (sessionsShown.length ? estimateTokens('\n## Recent sessions\n') : 0)

  let carry = 0
  const blocks: { id: string; kind: MemoryKind; line: string; tokens: number }[] = []
  const sectionTitles = new Map<MemoryKind, string>()

  for (const section of SECTIONS) {
    sectionTitles.set(section.kind, section.title)
    let budget = Math.min(remaining, Math.floor(max * section.share) + carry)
    const spent0 = budget
    const ranked = active
      .filter(m => m.kind === section.kind)
      .map(m => ({ m, s: score(m, section, isStale(m) || reviewDue(m, now), now) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, section.max)

    if (ranked.length === 0) {
      carry = budget
      continue
    }
    const titleCost = estimateTokens(`\n## ${section.title}\n`)
    budget -= titleCost
    let used = 0
    let added = 0
    for (const { m } of ranked) {
      let line = render(m, staleness.get(m.id), MAX_BODY_CHARS, now)
      let cost = estimateTokens(line) + 1
      if (cost > budget - used) {
        line = render(m, staleness.get(m.id), MIN_BODY_CHARS, now)
        cost = estimateTokens(line) + 1
      }
      if (cost > budget - used) continue
      blocks.push({ id: m.id, kind: m.kind, line, tokens: cost })
      used += cost
      added++
    }
    const spent = added ? used + titleCost : 0
    remaining -= spent
    carry = Math.max(0, spent0 - spent)
  }

  const total = [...totalByKind.values()].reduce((a, b) => a + b, 0)
  const compose = (): string => {
    const parts = [header]
    if (handoffShown.length) parts.push(`\n## Where we left off\n${handoffShown.map(h => h.line).join('\n')}`)
    if (sessionsShown.length) parts.push(`\n## Recent sessions\n${sessionsShown.map(s => s.line).join('\n')}`)
    for (const section of SECTIONS) {
      const lines = blocks.filter(b => b.kind === section.kind).map(b => b.line)
      if (lines.length) parts.push(`\n## ${section.title}\n${lines.join('\n')}`)
    }
    const omitted = total - blocks.length - handoffShown.length
    const notes: string[] = []
    if (!totalByKind.get('overview')) notes.push('No overview recorded yet: add one with cairn_remember (kind: overview).')
    if (omitted > 0) notes.push(`${omitted} more memories not shown: use cairn_recall (query, kind, area) to fetch them.`)
    if (handoffShown.length || sessionsShown.length) notes.push('Picking up someone else’s work? cairn_resume has the full handoff and session detail.')
    if (notes.length) parts.push(`\n_${notes.join(' ')}_`)
    return parts.join('\n')
  }

  let text = compose()
  while (estimateTokens(text) > max && blocks.length > 0) {
    blocks.pop()
    text = compose()
  }

  return {
    projectId,
    status: 'ready',
    text,
    tokens: estimateTokens(text),
    includedIds: [...handoffShown.map(h => h.item.id), ...blocks.map(b => b.id)],
    staleIds,
    omitted: total - blocks.length - handoffShown.length,
    resume: resumeInfo(handoffs, sessions),
  }
}

export async function countActiveByKind(brain: Brain, projectId: string): Promise<Map<MemoryKind, number>> {
  const r = await brain.run(
    `MATCH (m:Memory {projectId: $projectId, status: 'active'}) RETURN m.kind AS kind, count(m) AS n`,
    { projectId },
  )
  const counts = new Map<MemoryKind, number>()
  for (const row of r.records) counts.set(row.get('kind') as MemoryKind, Number(row.get('n')))
  return counts
}

/**
 * The agent's entry point: a token-budgeted briefing of a project, with stale
 * memories flagged, or the onboarding prompt when the brain has nothing yet.
 */
export async function buildBriefing(brain: Brain, projectId: string, options: BriefingOptions = {}): Promise<Briefing> {
  const totals = await countActiveByKind(brain, projectId)
  const sessions = options.sessions ?? (await listSessions(brain, projectId, { limit: 3 }))
  if ([...totals.values()].reduce((a, b) => a + b, 0) === 0) {
    let text = onboardingPrompt(options.label ?? projectId)
    if (sessions.length) {
      const lines = fit(sessions, 700, (s, chars) => renderSessionLine(s, chars), SESSION_SIZES).map(s => s.line)
      if (lines.length) text += `\n\n## Recent sessions\n${lines.join('\n')}`
    }
    return { projectId, status: 'empty', text, tokens: estimateTokens(text), includedIds: [], staleIds: [], omitted: 0, resume: resumeInfo([], sessions) }
  }

  const memories = (
    await Promise.all(MEMORY_KINDS.map(kind => recall(brain, projectId, { kind, limit: MAX_RECALL_LIMIT })))
  ).flat()
  const staleness =
    options.staleness ?? (options.cwd ? await checkStaleness(options.cwd, memories) : new Map<string, Staleness>())

  return assembleBriefing(projectId, memories, staleness, totals, { ...options, sessions })
}
