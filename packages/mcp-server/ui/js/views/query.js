import { api } from '../api.js'
import { copyText, fmt, h, icon } from '../dom.js'

const HISTORY_KEY = 'aib-query-history'

const EXAMPLES = [
  ['Projects and sizes', 'MATCH (p:Project)\nOPTIONAL MATCH (m:Memory {projectId: p.id, status: "active"})\nRETURN p.id AS project, count(m) AS memories\nORDER BY memories DESC'],
  ['Memories by kind', 'MATCH (m:Memory {status: "active"})\nRETURN m.projectId AS project, m.kind AS kind, count(*) AS n\nORDER BY project, n DESC'],
  ['Most recent memories', 'MATCH (m:Memory)\nRETURN m.projectId AS project, m.kind AS kind, m.title AS title, toString(m.createdAt) AS written\nORDER BY m.createdAt DESC\nLIMIT 25'],
  ['Supersede chains', 'MATCH (new:Memory)-[:SUPERSEDES]->(old:Memory)\nRETURN new.projectId AS project, old.title AS was, new.title AS now, toString(new.createdAt) AS changed\nORDER BY new.createdAt DESC\nLIMIT 50'],
  ['Who writes memories', 'MATCH (m:Memory)\nRETURN coalesce(m.agent, "unknown") AS agent, coalesce(m.author, "unknown") AS author, count(*) AS memories\nORDER BY memories DESC'],
  ['Largest memories', 'MATCH (m:Memory)\nRETURN m.projectId AS project, m.title AS title, size(m.body) AS characters\nORDER BY characters DESC\nLIMIT 15'],
  ['Git remotes', 'MATCH (r:Remote)-[:BELONGS_TO]->(p:Project)\nRETURN p.id AS project, substring(r.hash, 0, 8) AS remote, toString(r.createdAt) AS added'],
  ['Everything, as a graph', 'MATCH (p:Project)-[r]->(x)\nRETURN p, r, x\nLIMIT 100'],
  ['Schema', 'CALL db.schema.visualization()'],
]

const loadHistory = () => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
  } catch {
    return []
  }
}
const saveHistory = list => {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 15)))
  } catch {
    /* storage unavailable */
  }
}

function cell(value) {
  if (value === null || value === undefined) return h('span', { class: 'muted' }, 'null')
  if (typeof value === 'object') {
    if (value._type === 'node') return h('span', { class: 'tag', title: JSON.stringify(value.properties, null, 2) }, `(${value.labels.join(':')}) ${value.properties.title ?? value.properties.id ?? value.properties.name ?? value.id}`)
    if (value._type === 'relationship') return h('span', { class: 'tag' }, `[:${value.type}]`)
    return h('span', { class: 'mono', title: JSON.stringify(value) }, JSON.stringify(value))
  }
  return String(value)
}

const toCsv = ({ columns, rows }) => {
  const esc = v => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return [columns.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n')
}

export async function mount(container) {
  const editor = h('textarea', { rows: 6, spellcheck: 'false', 'aria-label': 'Cypher query', placeholder: 'MATCH (m:Memory) RETURN m LIMIT 10' })
  editor.value = EXAMPLES[1][1]
  const result = h('div', { class: 'card flush' }, h('div', { class: 'empty' }, 'Run a query to see rows here.'))
  const runBtn = h('button', { class: 'btn primary', type: 'button' }, icon('play'), 'Run', h('span', { class: 'muted', style: { color: 'inherit', opacity: 0.7, fontSize: '11px' } }, 'Ctrl+Enter'))
  const history = h('div', { class: 'row' })
  let last = null

  function drawHistory() {
    const items = loadHistory()
    history.replaceChildren(...(items.length ? [h('span', { class: 'hint' }, 'Recent:'), ...items.slice(0, 6).map(q => h('button', { class: 'chip', type: 'button', title: q, onclick: () => { editor.value = q; editor.focus() } }, q.replace(/\s+/g, ' ').slice(0, 34)))] : []))
  }

  async function run() {
    const query = editor.value.trim()
    if (!query) return
    runBtn.disabled = true
    result.replaceChildren(h('div', { class: 'empty' }, 'Running…'))
    try {
      const r = await api('cypher', { body: { query } })
      last = r
      saveHistory([query, ...loadHistory().filter(q => q !== query)])
      drawHistory()
      result.replaceChildren(
        h('div', { class: 'head', style: { padding: '12px 16px 0' } }, h('span', { class: 'muted' }, `${r.rows.length}${r.truncated ? '+' : ''} row${r.rows.length === 1 ? '' : 's'} · ${fmt.ms(r.elapsedMs)}${r.truncated ? ' · truncated' : ''}`), h('div', { class: 'tools' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(toCsv(r), 'CSV copied') }, icon('copy'), 'CSV'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(JSON.stringify(r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))), null, 2), 'JSON copied') }, icon('copy'), 'JSON'))),
        r.rows.length
          ? h('div', { class: 'scroll', style: { maxHeight: '520px' } }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, r.columns.map(c => h('th', null, c)))), h('tbody', null, r.rows.map(row => h('tr', null, row.map(v => h('td', { class: 'mono-cell', title: typeof v === 'string' ? v : undefined }, cell(v))))))))
          : h('div', { class: 'empty' }, 'The query ran and returned no rows.'),
      )
    } catch (error) {
      result.replaceChildren(h('div', { style: { padding: '16px' } }, h('p', { class: 'error', style: { margin: 0 } }, error.message)))
    } finally {
      runBtn.disabled = false
    }
  }

  runBtn.addEventListener('click', run)
  editor.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      run()
    }
  })

  container.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Query'), h('div', { class: 'sub' }, 'Read-only Cypher against the database. Writes are refused twice: by a keyword screen and by the database itself.'))),
    h('div', { class: 'card stack', style: { marginBottom: '14px' } },
      h('div', { class: 'row' }, ...EXAMPLES.map(([label, q]) => h('button', { class: 'chip', type: 'button', onclick: () => { editor.value = q; editor.focus() } }, label))),
      editor,
      h('div', { class: 'row' }, runBtn, h('span', { class: 'hint' }, 'Up to 200 rows, 10 second limit.'), h('span', { class: 'grow' }), history),
    ),
    result,
  )
  drawHistory()
}
