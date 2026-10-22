import type { Brain } from './db.js'
import { type Memory, recall } from './memory.js'
import { clip } from './redact.js'
import { type SessionRecord, listSessions } from './sessions.js'

/**
 * Everything someone needs to carry on another agent's work, in one piece of text: the handoffs in
 * full, what each recent session asked and left behind, what is open, and how to check the repository
 * against where the work stopped. Unlike the briefing it is not trimmed to a budget: it is read once,
 * deliberately, by an agent that is picking work up.
 */

export interface ResumeWorkspace {
  branch?: string
  head?: string
  dirty?: string[]
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`

function renderSessionFull(s: SessionRecord): string {
  const where = [s.machine ?? 'unknown machine', s.agent ? `(${s.agent})` : '', s.author ? `by ${s.author}` : '', s.branch ? `on ${s.branch}` : '', s.head ? `at ${s.head.slice(0, 7)}` : '']
    .filter(Boolean)
    .join(' ')
  const lines = [`### ${when(s.updatedAt)} · ${where}`]
  if (s.prompts.length) {
    lines.push('What the person asked, oldest first (the first and the latest requests are kept):')
    for (const p of s.prompts) lines.push(`- ${p.at ? `${when(p.at)}: ` : ''}${clip(p.text.replace(/\s+/g, ' '), 600)}`)
  }
  if (s.lastReply) lines.push(`The agent's last message:\n> ${s.lastReply.replace(/\n/g, '\n> ')}`)
  if (s.touched.length) lines.push(`Files edited (${s.touched.length}): ${s.touched.slice(0, 40).join(', ')}${s.touched.length > 40 ? ', …' : ''}`)
  if (s.commits.length) lines.push(`Commits made:\n${s.commits.map(c => `- ${c}`).join('\n')}`)
  if (s.dirty.length) lines.push(`Left uncommitted (${s.dirty.length}): ${s.dirty.slice(0, 40).join(', ')}${s.dirty.length > 40 ? ', …' : ''}`)
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 6)
  if (tools.length) lines.push(`Tools used: ${tools.map(([t, n]) => `${t} ×${n}`).join(', ')}`)
  return lines.join('\n')
}

function checks(handoffs: readonly Memory[], sessions: readonly SessionRecord[], here?: ResumeWorkspace): string[] {
  const out: string[] = []
  const h = handoffs[0]
  if (h?.commitSha) {
    out.push(`The latest handoff (${h.topic ?? 'default'}, ${when(h.createdAt)}${h.machine ? `, from ${h.machine}` : ''}) was written at commit ${h.commitSha.slice(0, 7)}.`)
    out.push(`  - Is that commit here? \`git cat-file -t ${h.commitSha.slice(0, 12)}\` should print "commit". If it does not, it was never pushed from the machine it was made on: ask the person whether that machine is still reachable.`)
    out.push(`  - What has happened since: \`git log --oneline ${h.commitSha.slice(0, 12)}..HEAD\``)
  }
  if (h) {
    out.push('Nothing in the handoff has been verified. "Done" is what the agent that wrote it reported, and a session can end with work unfinished that it believed finished. Before relying on it:')
    out.push('  - Run the handoff\'s "How to check" commands, if it has any, and read the tests.')
    out.push('  - Compare each "done" item with "Files edited" and "Commits made" in the recorded sessions below: those were recorded from the repository, not written by the agent.')
    if (h.paths.length && h.commitSha) out.push(`  - See what changed in the files it is about since: \`git diff --stat ${h.commitSha.slice(0, 12)}..HEAD -- ${h.paths.slice(0, 8).join(' ')}\``)
  }
  const s = sessions[0]
  if (s?.dirty.length) {
    out.push(`The latest session (${s.machine ?? 'unknown machine'}, ${when(s.updatedAt)}) ended with ${s.dirty.length} uncommitted file${s.dirty.length === 1 ? '' : 's'}: ${s.dirty.slice(0, 12).join(', ')}${s.dirty.length > 12 ? ', …' : ''}. That work may exist only on that machine. If it is gone, the notes above are what is left of it.`)
  }
  if (here && (here.branch || here.head)) {
    out.push(`You are on ${here.branch ? `branch ${here.branch}` : 'a detached HEAD'}${here.head ? ` at ${here.head.slice(0, 7)}` : ''}${here.dirty?.length ? ` with ${here.dirty.length} uncommitted file${here.dirty.length === 1 ? '' : 's'}` : ''}.`)
    if (h?.topic && here.branch && h.topic !== here.branch.toLowerCase()) out.push(`  - The latest handoff is for branch "${h.topic}", not "${here.branch}": check you are on the right branch.`)
  }
  return out
}

export async function buildResume(brain: Brain, projectId: string, options: { label?: string; here?: ResumeWorkspace } = {}): Promise<string> {
  const [handoffs, sessions, threads] = await Promise.all([
    recall(brain, projectId, { kind: 'handoff', sort: 'recent', limit: 4 }),
    listSessions(brain, projectId, { limit: 5 }),
    recall(brain, projectId, { kind: 'thread', sort: 'recent', limit: 6 }),
  ])
  const parts = [`# Resume: ${options.label ?? projectId}`]

  if (!handoffs.length && !sessions.length && !threads.length) {
    parts.push('Nothing has been handed off yet and no session has been recorded. Use cairn_briefing for what is known, and start the first handoff yourself with cairn_handoff when you stop.')
    return parts.join('\n\n')
  }

  parts.push('## Where the work stands')
  if (handoffs.length) {
    parts.push(
      handoffs
        .map(m => `### ${m.title}\n${[m.topic ? `topic: ${m.topic}` : '', when(m.createdAt), m.machine ?? m.author ?? '', `#${m.id.slice(0, 8)}`].filter(Boolean).join(' · ')}\n\n${m.body}`)
        .join('\n\n'),
    )
  } else {
    parts.push('No handoff was written. The sessions below were recorded automatically from the conversations.')
  }

  if (sessions.length) parts.push(`## Recent sessions\nRecorded automatically from the conversations and the repository, newest first.\n\n${sessions.map(renderSessionFull).join('\n\n')}`)
  if (threads.length) parts.push(`## Open threads\n${threads.map(t => `- **${t.title}** #${t.id.slice(0, 8)}: ${clip(t.body.replace(/\s+/g, ' '), 400)}`).join('\n')}`)

  const check = checks(handoffs, sessions, options.here)
  if (check.length) parts.push(`## Check the repository\n${check.join('\n')}`)
  parts.push('_When you stop, write what you left with cairn_handoff so the next agent can do this from you._')
  return parts.join('\n\n')
}
