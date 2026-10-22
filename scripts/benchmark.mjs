// Measures what starting a session costs with and without Agent Cairn, on a repository you have checked out.
// Usage (needs CAIRN_URL and CAIRN_TOKEN, and the folder linked with `cairn init`):
//   node scripts/benchmark.mjs <repo-dir> [facts.json] [--json]
//
// Two things are measured, because tokens saved mean nothing if the answer is no longer there:
//   1. Orientation cost: tokens an agent loads to get oriented (the docs; the docs plus all the source) against
//      the Cairn briefing and the full resume.
//   2. Findability: for each non-obvious fact in facts.json, whether it can be found in the docs, in the source,
//      in the briefing, and in a single recall query.
// Tokens are estimated as characters / 4 on both sides, so the ratio is meaningful even though the count is not exact.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const asJson = process.argv.includes('--json')
const dir = args[0]
if (!dir) {
  console.error('Usage: node scripts/benchmark.mjs <repo-dir> [facts.json] [--json]')
  process.exit(1)
}
const url = process.env.CAIRN_URL?.replace(/\/+$/, '')
const token = process.env.CAIRN_TOKEN
if (!url || !token) {
  console.error('Set CAIRN_URL and CAIRN_TOKEN.')
  process.exit(1)
}

const tokens = text => Math.ceil(text.length / 4)
const link = JSON.parse(readFileSync(join(dir, '.cairn.json'), 'utf8')).projectId
const files = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean)

const TEXT = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.yml', '.yaml', '.cs', '.csproj', '.xaml', '.py', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.hpp', '.sh', '.toml', '.xml', '.txt', '.cmake'])
const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|node_modules|vendor|dist|bin|obj|3rdparty|docs\/images)\//
const SKIP_FILE = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.min\.js)$/
const readable = f => (TEXT.has(extname(f).toLowerCase()) || /(^|\/)(Dockerfile|Makefile)$/.test(f)) && !SKIP.test(f) && !SKIP_FILE.test(f) && statSync(join(dir, f)).size < 400_000
const read = f => readFileSync(join(dir, f), 'utf8')

const isDoc = f => /^(README|CLAUDE|CONTRIBUTING|CHANGELOG|ARCHITECTURE)/i.test(f) || /^docs\/.*\.md$/i.test(f) || /(^|\/)(package\.json|.*\.csproj|Cargo\.toml|go\.mod|pyproject\.toml)$/.test(f)
const docs = files.filter(f => readable(f) && isDoc(f))
const source = files.filter(f => readable(f) && !isDoc(f))
const docText = docs.map(read).join('\n')
const sourceText = source.map(read).join('\n')

async function mcp(project, name, argumentsObject = {}) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-cairn-project': project },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: argumentsObject } }),
  })
  const reply = await res.json()
  if (reply.error) throw new Error(reply.error.message)
  return reply.result?.content?.map(c => c.text).join('\n') ?? ''
}

const briefing = await mcp(link, 'cairn_briefing', { max_tokens: 1200 })
const resume = await mcp(link, 'cairn_resume')
const status = await mcp(link, 'cairn_status')

const cost = {
  project: link,
  memories: Number(/Active memories: (\d+)/.exec(status)?.[1] ?? 0),
  docs: { files: docs.length, tokens: tokens(docText) },
  docsAndSource: { files: docs.length + source.length, tokens: tokens(docText) + tokens(sourceText) },
  briefing: { tokens: tokens(briefing) },
  resume: { tokens: tokens(resume) },
}

const facts = args[1] ? JSON.parse(readFileSync(args[1], 'utf8')) : []
const found = []
for (const fact of facts) {
  const re = new RegExp(fact.pattern, 'i')
  const recalled = await mcp(link, 'cairn_recall', { query: fact.query, limit: 5 })
  found.push({ question: fact.question, docs: re.test(docText), source: re.test(sourceText), briefing: re.test(briefing), recall: re.test(recalled), recallTokens: tokens(recalled) })
}

if (asJson) {
  console.log(JSON.stringify({ cost, found }, null, 2))
  process.exit(0)
}
const n = x => x.toLocaleString('en-US')
console.log(`Project ${cost.project}: ${cost.memories} memories\n`)
console.log('| What the agent loads at the start | Tokens | Cairn briefing is |')
console.log('| --- | ---: | ---: |')
console.log(`| Read the docs (${cost.docs.files} files) | ${n(cost.docs.tokens)} | ${(cost.docs.tokens / cost.briefing.tokens).toFixed(1)}x smaller |`)
console.log(`| Read the docs and all the source (${cost.docsAndSource.files} files) | ${n(cost.docsAndSource.tokens)} | ${(cost.docsAndSource.tokens / cost.briefing.tokens).toFixed(0)}x smaller |`)
console.log(`| **Cairn briefing** (default budget) | **${n(cost.briefing.tokens)}** | |`)
console.log(`| Cairn resume (full, unbudgeted) | ${n(cost.resume.tokens)} | |`)
if (found.length) {
  const yes = v => (v ? 'yes' : 'no')
  console.log(`\n| Non-obvious fact | In the docs | In the source | In the briefing | In one recall query |`)
  console.log('| --- | :-: | :-: | :-: | :-: |')
  for (const f of found) console.log(`| ${f.question} | ${yes(f.docs)} | ${yes(f.source)} | ${yes(f.briefing)} | ${yes(f.recall)} |`)
  const count = key => found.filter(f => f[key]).length
  console.log(`\nFound: docs ${count('docs')}/${found.length}, source ${count('source')}/${found.length}, briefing ${count('briefing')}/${found.length}, one recall query ${count('recall')}/${found.length} (about ${n(Math.round(found.reduce((a, f) => a + f.recallTokens, 0) / found.length))} tokens per query).`)
}
