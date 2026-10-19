/**
 * Best-effort removal of secrets from text that is about to be stored. Session capture keeps what the
 * person typed and what the agent said, and people paste tokens and passwords into conversations, so
 * everything is run through this on the client (before it leaves the machine) and again on the server.
 * It cannot catch everything: capture can be turned down with CAIRN_SESSION_CAPTURE.
 */

const REDACTED = '[redacted]'

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `[redacted private key]`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED], // JWTs
  [/\baib_[A-Za-z0-9_-]{16,}/g, REDACTED], // Agent Cairn tokens
  [/\bnpm_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `Bearer ${REDACTED}`],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, `$1${REDACTED}@`], // user:password@host
  // "password is hunter2", "my token: abc123"
  [/\b(password|passwd|passphrase|secret|token|api[_ -]?key)\s+(?:is|was|are)\s+(?!\[redacted\])\S{4,}/gi, `$1 is ${REDACTED}`],
  // PASSWORD=..., "apiKey": "...", token: ...
  [/\b((?:[A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|apikey|authorization))["']?\s*[:=]\s*)["']?(?!\[redacted\])(?!Bearer\b)[^\s"',;]{6,}["']?/gi, `$1${REDACTED}`],
]

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text)
}

/** Shortens to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** What is stored of free text from a conversation: secrets removed, then shortened. */
export const sanitize = (text: string, max: number): string => clip(redactSecrets(text), max)
