const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export interface TurnSummary {
  /** File-editing tool calls since the person's last prompt. */
  edits: number
  /** Whether cairn_checkpoint was called since that prompt. */
  checkpointed: boolean
  /** Whether cairn_handoff was called since that prompt. */
  handedOff: boolean
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
  let handedOff = false

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
      handedOff = false
    } else if (entry.type === 'assistant') {
      for (const block of blocksOf(entry.message)) {
        if (block.type !== 'tool_use' || !block.name) continue
        if (EDIT_TOOLS.has(block.name)) edits++
        if (block.name.endsWith('cairn_checkpoint')) checkpointed = true
        if (block.name.endsWith('cairn_handoff')) handedOff = true
      }
    }
  }
  return { edits, checkpointed, handedOff }
}

// ---- the whole session -------------------------------------------------------

export interface SessionDigest {
  startedAt: string | null
  endedAt: string | null
  /** What the person typed, in order. */
  prompts: { at: string | null; text: string }[]
  /** Files the agent edited, as the absolute paths in the tool calls. */
  touched: string[]
  /** How many times each tool was used. */
  tools: Record<string, number>
  /** The agent's last message to the person. */
  lastReply: string | null
}

// <command-message> repeats the command's name, so it is dropped; the name and arguments stay as `/name args`
const WRAPPERS = /<(system-reminder|local-command-stdout|local-command-caveat|command-message)[^>]*>[\s\S]*?<\/\1>/g
const TAGS = /<\/?(command-name|command-args)[^>]*>/g

/** The words of a person's message, without the markup Claude Code wraps around slash commands and reminders. */
function promptText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  const raw =
    typeof content === 'string'
      ? content
      : blocksOf(message)
          .filter(b => b.type === 'text')
          .map(b => (b as { text?: string }).text ?? '')
          .join('\n')
  return raw.replace(WRAPPERS, '').replace(TAGS, ' ').replace(/\s+/g, ' ').trim()
}

// hook feedback comes back into the conversation as a message, but a person did not type it
const NOT_A_PERSON = /^(Stop hook feedback|Caveat:|\[Request interrupted)/

const textOfAssistant = (message: unknown): string =>
  blocksOf(message)
    .filter(b => b.type === 'text')
    .map(b => (b as { text?: string }).text ?? '')
    .join('\n')
    .trim()

/** Reads a whole Claude Code transcript and picks out what a later reader needs. Tolerates junk lines. */
export function digestSession(jsonl: string): SessionDigest {
  const digest: SessionDigest = { startedAt: null, endedAt: null, prompts: [], touched: [], tools: {}, lastReply: null }
  const touched = new Set<string>()

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let entry: { type?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; message?: unknown }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.isSidechain) continue
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : null
    if (at) {
      digest.startedAt ??= at
      digest.endedAt = at
    }

    if (entry.type === 'user' && !entry.isMeta && isPrompt(entry.message)) {
      const text = promptText(entry.message)
      if (text && !NOT_A_PERSON.test(text)) digest.prompts.push({ at, text })
    } else if (entry.type === 'assistant') {
      const reply = textOfAssistant(entry.message)
      if (reply) digest.lastReply = reply
      for (const block of blocksOf(entry.message) as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (block.type !== 'tool_use' || !block.name) continue
        digest.tools[block.name] = (digest.tools[block.name] ?? 0) + 1
        if (EDIT_TOOLS.has(block.name)) {
          const file = block.input?.file_path ?? block.input?.notebook_path
          if (typeof file === 'string') touched.add(file)
        }
      }
    }
  }
  digest.touched = [...touched]
  return digest
}
