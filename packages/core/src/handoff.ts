import type { CheckpointDecision } from './checkpoint.js'
import type { Brain } from './db.js'
import { type Memory, MemoryValidationError, type RememberInput, remember } from './memory.js'
import { clip, sanitize } from './redact.js'

/**
 * A handoff is the answer to "if someone else sat down at this project right now, what would they need
 * to know?": what is done, what was in flight, what comes next, what is blocked, what was tried and
 * dropped, and what the person asked for that must not be forgotten. It is the part only the agent
 * that did the work can write well; the rest of a session is captured without its help.
 */

export const HANDOFF_STATUSES = ['in_progress', 'blocked', 'paused', 'done'] as const
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number]

const STATUS_LABEL: Record<HandoffStatus, string> = {
  in_progress: 'in progress',
  blocked: 'blocked',
  paused: 'paused',
  done: 'done',
}

export interface HandoffWorkspace {
  branch?: string
  head?: string
  /** Files with uncommitted changes. */
  dirty?: string[]
}

export interface HandoffInput {
  /** What the work is, in a line. Becomes the title. */
  goal: string
  status?: HandoffStatus
  /** What is finished, concretely. */
  done?: string[]
  /** What was mid-flight, with its exact state: the file, the function, the half-finished step. */
  inProgress?: string
  /** What to do next, in order. */
  next?: string[]
  /** Open questions and things waiting on a person. */
  blockers?: string[]
  /** What is being taken as given and is not obvious from the code: environment, scope, constraints, things believed but not checked. */
  assumptions?: string[]
  /** What was tried and did not work, and why, so nobody repeats it. */
  deadEnds?: string[]
  /** What the person asked for or said that the next agent must keep honouring. */
  fromUser?: string
  /** How to check the work: commands, tests, URLs. */
  verify?: string
  /** Choices worth keeping on their own; each is also stored as a decision memory. */
  decisions?: CheckpointDecision[]
  paths?: string[]
  /** The line of work, so a new handoff replaces the old one for it. Defaults to the branch. */
  topic?: string
  /** Where the repository stood; filled in by the client's hook. */
  workspace?: HandoffWorkspace
  commitSha?: string
  author?: string
  agent?: string
  machine?: string
}

export interface HandoffResult {
  handoff: Memory
  decisions: Memory[]
}

const LIST_MAX = 30
const ITEM_MAX = 600

const items = (v: string[] | undefined): string[] =>
  (v ?? []).filter(x => typeof x === 'string' && x.trim() !== '').slice(0, LIST_MAX).map(x => sanitize(x, ITEM_MAX))

/** The handoff as readable Markdown: what is stored, shown in the dashboard and handed to the next agent. */
export function renderHandoff(input: HandoffInput): string {
  const status = STATUS_LABEL[input.status ?? 'in_progress']
  const parts: string[] = [`Status: ${status}`]
  const section = (title: string, lines: string[], numbered = false) => {
    if (lines.length) parts.push(`## ${title}\n${lines.map((l, i) => (numbered ? `${i + 1}. ${l}` : `- ${l}`)).join('\n')}`)
  }
  const inProgress = input.inProgress?.trim() ? sanitize(input.inProgress, 1500) : ''
  if (inProgress) parts.push(`## In progress
${inProgress}`)
  section('Next', items(input.next), true)
  section('Blocked or open', items(input.blockers))
  section('Assumptions we are operating under', items(input.assumptions))
  const fromUser = input.fromUser?.trim() ? sanitize(input.fromUser, 1500) : ''
  if (fromUser) parts.push(`## From the person
${fromUser}`)
  section('Tried and dropped', items(input.deadEnds))
  section('Done', items(input.done))
  const verify = input.verify?.trim() ? sanitize(input.verify, 1000) : ''
  if (verify) parts.push(`## How to check
${verify}`)

  const w = input.workspace
  if (w && (w.branch || w.head || w.dirty?.length)) {
    const where = [w.branch ? `branch ${w.branch}` : '', w.head ? `at ${w.head.slice(0, 7)}` : ''].filter(Boolean).join(' ')
    const dirty = w.dirty?.length ? `${w.dirty.length} uncommitted file${w.dirty.length === 1 ? '' : 's'}: ${w.dirty.slice(0, 12).join(', ')}${w.dirty.length > 12 ? ', …' : ''}` : 'working tree clean'
    parts.push(`## Workspace\n${[where, dirty].filter(Boolean).join('; ')}`)
  }
  return parts.join('\n\n')
}

/**
 * Stores a handoff. It replaces the active handoff for the same topic (kept as history), so there is one
 * current "where we left off" per line of work. Each decision is also filed as a decision memory.
 */
export async function recordHandoff(brain: Brain, projectId: string, input: HandoffInput): Promise<HandoffResult> {
  const goal = input.goal?.trim() ?? ''
  if (!goal) throw new MemoryValidationError('goal is required: what is this work?')
  if (input.status !== undefined && !HANDOFF_STATUSES.includes(input.status)) {
    throw new MemoryValidationError(`status must be one of: ${HANDOFF_STATUSES.join(', ')}.`)
  }
  const has =
    items(input.done).length || items(input.next).length || items(input.blockers).length || items(input.assumptions).length || input.inProgress?.trim() || items(input.deadEnds).length
  if (!has) {
    throw new MemoryValidationError('A handoff needs at least one of: what is done, in progress, next, blocked, assumptions, or tried and dropped.')
  }

  const topic = (input.topic?.trim() || input.workspace?.branch?.trim() || 'default').toLowerCase().slice(0, 64)
  const previous = await brain.run(
    `MATCH (m:Memory {projectId: $projectId, kind: 'handoff', status: 'active', topic: $topic}) RETURN m.id AS id`,
    { projectId, topic },
  )
  const provenance = { commitSha: input.commitSha ?? input.workspace?.head, author: input.author, agent: input.agent, machine: input.machine }

  const handoff = await remember(brain, projectId, {
    ...provenance,
    kind: 'handoff',
    title: clip(sanitize(goal, 200), 200),
    body: renderHandoff(input),
    area: 'handoff',
    topic,
    paths: input.paths,
    importance: 4,
    supersedes: previous.records.map(r => r.get('id') as string),
  })

  const decisions: Memory[] = []
  for (const d of input.decisions ?? []) {
    const decision: RememberInput = { ...provenance, kind: 'decision', title: d.title, body: d.body, area: d.area, paths: d.paths ?? input.paths, importance: d.importance }
    decisions.push(await remember(brain, projectId, decision))
  }
  return { handoff, decisions }
}
