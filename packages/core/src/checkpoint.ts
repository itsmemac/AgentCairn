import type { Brain } from './db.js'
import { type Memory, type RememberInput, remember } from './memory.js'

export interface CheckpointDecision {
  title: string
  body: string
  area?: string
  paths?: string[]
  importance?: number
}

export interface CheckpointInput {
  /** What was being done. Becomes the checkpoint's title. */
  goal: string
  /** What came of it: what changed and how it ended. */
  outcome: string
  /** Choices worth keeping; each is also stored as a decision memory. */
  decisions?: CheckpointDecision[]
  /** What remains; also stored as an open thread. */
  next?: string
  /** Open threads this goal finished (ids or prefixes); the checkpoint supersedes them. */
  resolves?: string[]
  area?: string
  paths?: string[]
  commitSha?: string
  author?: string
  agent?: string
  machine?: string
  /** Set by the server from the authenticated request. */
  writtenBy?: string
  viaToken?: string
}

export interface CheckpointResult {
  checkpoint: Memory
  decisions: Memory[]
  thread: Memory | null
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/**
 * Records the end of a goal: one checkpoint memory, one decision memory per
 * decision, and an open thread for what is next. Writes happen in order, so a
 * failure part-way leaves the earlier memories in place.
 */
export async function checkpoint(brain: Brain, projectId: string, input: CheckpointInput): Promise<CheckpointResult> {
  const provenance = {
    commitSha: input.commitSha,
    author: input.author,
    agent: input.agent,
    machine: input.machine,
    writtenBy: input.writtenBy,
    viaToken: input.viaToken,
  }
  const next = input.next?.trim()

  const cp = await remember(brain, projectId, {
    ...provenance,
    kind: 'checkpoint',
    title: clip(input.goal.trim(), 200),
    body: next ? `${input.outcome.trim()}\n\nNext: ${next}` : input.outcome,
    area: input.area,
    paths: input.paths,
    supersedes: input.resolves,
  })

  const decisions: Memory[] = []
  for (const d of input.decisions ?? []) {
    const decision: RememberInput = {
      ...provenance,
      kind: 'decision',
      title: d.title,
      body: d.body,
      area: d.area ?? input.area,
      paths: d.paths ?? input.paths,
      importance: d.importance,
    }
    decisions.push(await remember(brain, projectId, decision))
  }

  const thread = next
    ? await remember(brain, projectId, {
        ...provenance,
        kind: 'thread',
        title: clip(`Next after: ${input.goal.trim()}`, 200),
        body: next,
        area: input.area,
        paths: input.paths,
      })
    : null

  return { checkpoint: cp, decisions, thread }
}
