const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export interface TurnSummary {
  /** File-editing tool calls since the person's last prompt. */
  edits: number
  /** Whether cairn_checkpoint was called since that prompt. */
  checkpointed: boolean
}

type Block = { type?: string; name?: string }

const blocksOf = (message: unknown): Block[] => {
  const content = (message as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

/** A person's prompt, as opposed to a tool result that the transcript also stores as a user message. */
function isPrompt(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return true
  const blocks = blocksOf(message)
  return blocks.length > 0 && blocks.every(b => b.type !== 'tool_result') && blocks.some(b => b.type === 'text')
}

/** Reads a Claude Code transcript (JSONL) and summarizes the current turn. Tolerates junk lines. */
export function analyzeTurn(jsonl: string): TurnSummary {
  let edits = 0
  let checkpointed = false

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let entry: { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: unknown }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.isSidechain) continue

    if (entry.type === 'user' && !entry.isMeta && isPrompt(entry.message)) {
      edits = 0
      checkpointed = false
    } else if (entry.type === 'assistant') {
      for (const block of blocksOf(entry.message)) {
        if (block.type !== 'tool_use' || !block.name) continue
        if (EDIT_TOOLS.has(block.name)) edits++
        if (block.name.endsWith('cairn_checkpoint')) checkpointed = true
      }
    }
  }
  return { edits, checkpointed }
}
