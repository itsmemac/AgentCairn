// Builds the GitHub wiki from docs/: the docs stay the source of truth in the repository, the wiki is a copy.
// Usage: node scripts/sync-wiki.mjs <outDir> [owner/repo] [branch]
// Wiki pages are flat and addressed by name, so relative links between docs are rewritten to page names,
// and links to other files in the repository become absolute links to GitHub.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'

const out = process.argv[2]
const repo = process.argv[3] ?? 'itsmemac/AgentCairn'
const branch = process.argv[4] ?? 'main'
if (!out) {
  console.error('Usage: node scripts/sync-wiki.mjs <outDir> [owner/repo] [branch]')
  process.exit(1)
}

const PAGES = [
  ['faq.md', 'FAQ', 'FAQ'],
  ['benchmark.md', 'Benchmark', 'Benchmark'],
  ['self-hosting.md', 'Self-hosting', 'Self-hosting'],
  ['unraid.md', 'Unraid', 'Unraid'],
  ['claude-code.md', 'Claude-Code', 'Using it with Claude Code'],
  ['access-control.md', 'Access-control', 'Users, projects and access control'],
  ['configuration.md', 'Configuration', 'Configuration'],
  ['architecture.md', 'Architecture', 'Architecture'],
]
const pageOf = new Map(PAGES.map(([file, page]) => [file, page]))
const blob = path => `https://github.com/${repo}/blob/${branch}/${path}`
const raw = path => `https://raw.githubusercontent.com/${repo}/${branch}/${path}`

/** Rewrites one link target found in docs/<file>. */
function rewrite(target) {
  if (/^([a-z]+:|#|mailto:)/i.test(target)) return target
  const [path, hash] = target.split('#')
  const resolved = posix.normalize(posix.join('docs', path))
  const page = pageOf.get(resolved.replace(/^docs\//, ''))
  if (resolved.startsWith('docs/') && page) return `${page}${hash ? `#${hash}` : ''}`
  if (/\.(png|jpe?g|gif|svg)$/i.test(resolved)) return raw(resolved)
  return `${blob(resolved)}${hash ? `#${hash}` : ''}`
}

mkdirSync(out, { recursive: true })
const banner = file => `> This page is generated from [\`docs/${file}\`](${blob(`docs/${file}`)}) in the repository. Edit it there, not here: changes made in the wiki are overwritten.\n\n`

for (const [file, page] of PAGES) {
  const source = readFileSync(join('docs', file), 'utf8')
  // keep fenced code untouched; rewrite links only in prose
  let fenced = false
  const body = source
    .split('\n')
    .map(line => {
      if (line.startsWith('```')) fenced = !fenced
      return fenced || line.startsWith('```') ? line : line.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (_, open, target, close) => `${open}${rewrite(target)}${close}`)
    })
    .join('\n')
  writeFileSync(join(out, `${page}.md`), banner(file) + body)
}

const list = PAGES.map(([, page, title]) => `- [${title}](${page})`).join('\n')
writeFileSync(
  join(out, 'Home.md'),
  `# Agent Cairn

Shared, persistent project memory for AI coding agents, on a server you own. Another agent, on any machine, can pick up exactly where the last one left off.

**Start here:** the [README](https://github.com/${repo}#readme) has the install steps. Questions and ideas go in [Discussions](https://github.com/${repo}/discussions); bugs go in [Issues](https://github.com/${repo}/issues).

## Pages

${list}

These pages are generated from \`docs/\` in the repository. Edit them there.
`,
)
writeFileSync(join(out, '_Sidebar.md'), `**[Home](Home)**\n\n${list}\n\n[Repository](https://github.com/${repo}) · [Discussions](https://github.com/${repo}/discussions) · [Changelog](${blob('CHANGELOG.md')})\n`)
console.log(`Wrote ${PAGES.length + 2} pages to ${out}`)
console.log(`Unused docs: ${readdirSync('docs').filter(f => f.endsWith('.md') && !pageOf.has(f)).join(', ') || 'none'}`)
