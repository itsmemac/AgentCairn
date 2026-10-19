import type { Brain } from './db.js'
import { MAX_RECALL_LIMIT, MEMORY_KINDS, type Memory, type MemoryKind, recall } from './memory.js'
import { onboardingPrompt } from './onboarding.js'
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

const SECTIONS: readonly Section[] = [
  { kind: 'overview', title: 'Overview', share: 0.25, max: 4 },
  { kind: 'convention', title: 'Conventions', share: 0.15, max: 8 },
  { kind: 'gotcha', title: 'Gotchas', share: 0.15, max: 8 },
  { kind: 'thread', title: 'Open threads', share: 0.1, max: 6 },
  { kind: 'checkpoint', title: 'Recent checkpoints', share: 0.15, max: 3, recencyOnly: true },
  { kind: 'decision', title: 'Decisions', share: 0.15, max: 8 },
  { kind: 'glossary', title: 'Glossary', share: 0.05, max: 10 },
]

export interface BriefingOptions {
  maxTokens?: number
  /** Repo folder used to detect stale memories; omit to skip the check. */
  cwd?: string
  /** Staleness computed elsewhere (a remote server cannot see the repo); wins over `cwd`. */
  staleness?: ReadonlyMap<string, Staleness>
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
}

export const shortId = (id: string) => id.slice(0, 8)

const ageDays = (m: Memory, now: Date) => Math.max(0, (now.getTime() - Date.parse(m.createdAt)) / 86_400_000)

function score(m: Memory, section: Section, stale: boolean, now: Date): number {
  const recency = 2 * Math.exp(-ageDays(m, now) / 30)
  if (section.recencyOnly) return recency
  return m.importance * 2 + recency - (stale ? 1.5 : 0)
}

function render(m: Memory, stale: Staleness | undefined, bodyChars: number): string {
  const body = m.body.replace(/\s+/g, ' ').trim()
  const clipped = body.length > bodyChars ? `${body.slice(0, bodyChars - 1).trimEnd()}…` : body
  const area = m.area ? ` [${m.area}]` : ''
  const flag =
    stale?.status === 'stale' ? ` ⚠ may be stale (changed: ${stale.changedPaths.slice(0, 2).join(', ')})` : ''
  return `- **${m.title}**${area} #${shortId(m.id)}: ${clipped}${flag}`
}

/**
 * Pure assembly of a briefing from already-loaded memories. Sections follow a
 * fixed priority, each gets a share of the budget plus whatever earlier ones
 * left, and items are picked by score (importance, recency, minus staleness).
 * An item that does not fit is shortened once, then skipped.
 */
export function assembleBriefing(
  projectId: string,
  memories: readonly Memory[],
  staleness: ReadonlyMap<string, Staleness>,
  totalByKind: ReadonlyMap<MemoryKind, number>,
  options: Pick<BriefingOptions, 'maxTokens' | 'now'> = {},
): Briefing {
  const max = Math.min(Math.max(options.maxTokens ?? DEFAULT_BRIEFING_TOKENS, MIN_BRIEFING_TOKENS), MAX_BRIEFING_TOKENS)
  const now = options.now ?? new Date()
  const isStale = (m: Memory) => staleness.get(m.id)?.status === 'stale'

  const active = memories.filter(m => m.status === 'active')
  const staleIds = active.filter(isStale).map(m => m.id)
  const lastCheckpoint = active
    .filter(m => m.kind === 'checkpoint')
    .map(m => m.createdAt)
    .sort()
    .at(-1)

  const header = [
    `# Brain briefing: ${projectId}`,
    `${[...totalByKind.values()].reduce((a, b) => a + b, 0)} active memories. Last checkpoint: ${
      lastCheckpoint ? lastCheckpoint.slice(0, 10) : 'none'
    }.`,
    ...(staleIds.length ? [`⚠ ${staleIds.length} memories may be stale (files changed since they were written): verify before relying on them.`] : []),
  ].join('\n')

  const footerReserve = 60
  let remaining = max - estimateTokens(header) - footerReserve
  let carry = 0
  const blocks: { id: string; kind: MemoryKind; line: string; tokens: number }[] = []
  const sectionTitles = new Map<MemoryKind, string>()

  for (const section of SECTIONS) {
    sectionTitles.set(section.kind, section.title)
    let budget = Math.min(remaining, Math.floor(max * section.share) + carry)
    const spent0 = budget
    const ranked = active
      .filter(m => m.kind === section.kind)
      .map(m => ({ m, s: score(m, section, isStale(m), now) }))
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
      let line = render(m, staleness.get(m.id), MAX_BODY_CHARS)
      let cost = estimateTokens(line) + 1
      if (cost > budget - used) {
        line = render(m, staleness.get(m.id), MIN_BODY_CHARS)
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

  const compose = (): string => {
    const parts = [header]
    for (const section of SECTIONS) {
      const lines = blocks.filter(b => b.kind === section.kind).map(b => b.line)
      if (lines.length) parts.push(`\n## ${section.title}\n${lines.join('\n')}`)
    }
    const total = [...totalByKind.values()].reduce((a, b) => a + b, 0)
    const omitted = total - blocks.length
    const notes: string[] = []
    if (!totalByKind.get('overview')) notes.push('No overview recorded yet: add one with cairn_remember (kind: overview).')
    if (omitted > 0) notes.push(`${omitted} more memories not shown: use cairn_recall (query, kind, area) to fetch them.`)
    if (notes.length) parts.push(`\n_${notes.join(' ')}_`)
    return parts.join('\n')
  }

  let text = compose()
  while (estimateTokens(text) > max && blocks.length > 0) {
    blocks.pop()
    text = compose()
  }

  const total = [...totalByKind.values()].reduce((a, b) => a + b, 0)
  return {
    projectId,
    status: 'ready',
    text,
    tokens: estimateTokens(text),
    includedIds: blocks.map(b => b.id),
    staleIds,
    omitted: total - blocks.length,
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
  if ([...totals.values()].reduce((a, b) => a + b, 0) === 0) {
    const text = onboardingPrompt(options.label ?? projectId)
    return { projectId, status: 'empty', text, tokens: estimateTokens(text), includedIds: [], staleIds: [], omitted: 0 }
  }

  const memories = (
    await Promise.all(MEMORY_KINDS.map(kind => recall(brain, projectId, { kind, limit: MAX_RECALL_LIMIT })))
  ).flat()
  const staleness =
    options.staleness ?? (options.cwd ? await checkStaleness(options.cwd, memories) : new Map<string, Staleness>())

  return assembleBriefing(projectId, memories, staleness, totals, options)
}
