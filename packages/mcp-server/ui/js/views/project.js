import { api, qs } from '../api.js'
import { ago, debounce, emptyState, fmt, h, icon, KINDS, kindBar, renderNotes, searchBox, toast } from '../dom.js'
import { closeDrawer, openDrawer } from '../drawer.js'
import { importance, openMemory } from './memoryDrawer.js'

/** Deleting a project removes every memory under it, so it asks for the project's name first. */
function confirmDelete(id, detail, navigate) {
  const name = detail.name
  const input = h('input', { class: 'input', placeholder: name, 'aria-label': 'Project name to confirm', autocomplete: 'off', spellcheck: 'false', style: { width: '100%' } })
  const error = h('p', { class: 'error', hidden: '' })
  const go = h('button', { class: 'btn danger', type: 'button', disabled: '' }, icon('trash'), 'Delete project')
  const memories = detail.active + detail.superseded
  input.addEventListener('input', () => { go.disabled = input.value.trim() !== name })
  go.addEventListener('click', async () => {
    go.disabled = true
    try {
      await api(`projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
      closeDrawer()
      toast(`Deleted ${id}`)
      navigate('#/projects')
    } catch (e) {
      error.textContent = e.message
      error.hidden = false
      go.disabled = false
    }
  })
  openDrawer(
    h('strong', null, 'Delete project'),
    h(
      'div',
      { class: 'stack' },
      h('p', null, 'This permanently deletes ', h('b', null, name), ` and everything under it: ${fmt.int(memories)} ${memories === 1 ? 'memory' : 'memories'} (including superseded ones), ${fmt.int(detail.areas.length)} ${detail.areas.length === 1 ? 'area' : 'areas'} and ${fmt.int(detail.remotes)} git ${detail.remotes === 1 ? 'remote' : 'remotes'}. It cannot be undone.`),
      h('p', { class: 'dim' }, 'Agents that still point at this project will simply create it again, empty, the next time they write.'),
      h('div', { class: 'field' }, h('label', null, 'Type the project name to confirm'), input),
      error,
      go,
    ),
  )
  input.focus()
}

export async function mount(container, { params, navigate }) {
  const id = params.id
  const [detail, handoffs, sessions, membersReply] = await Promise.all([
    api(`projects/${encodeURIComponent(id)}`),
    api(`memories?${qs({ project: id, kind: 'handoff', sort: 'recent', limit: 3 })}`).then(r => r.memories, () => []),
    api(`projects/${encodeURIComponent(id)}/sessions?limit=8`).then(r => r.sessions, () => []),
    api(`projects/${encodeURIComponent(id)}/members`).then(r => r.members, () => []),
  ])
  let members = membersReply
  const role = detail.role
  const isOwner = role === 'owner'
  const canManage = role === 'owner' || role === 'maintainer'
  // newest first by default: what was written last is usually what matters most when picking work up
  const state = { kind: '', area: '', status: 'active', q: '', sort: 'recent' }

  const list = h('div', { class: 'stack', style: { gap: '10px' } })
  const count = h('span', { class: 'hint' })
  const search = searchBox({ placeholder: 'Search titles and bodies…', 'aria-label': 'Search memories', style: { width: '260px' } })
  const areaSelect = h('select', { 'aria-label': 'Area' }, h('option', { value: '' }, 'All areas'), detail.areas.map(a => h('option', { value: a.name }, `${a.name} · ${a.count}`)))
  const kindChips = KINDS.map(k => {
    const chip = h('button', { class: `chip kindchip k-${k}`, type: 'button', 'aria-pressed': 'false', disabled: !detail.counts[k] }, h('i', { class: 'sw' }), `${k} ${detail.counts[k] ?? 0}`)
    chip.addEventListener('click', () => {
      state.kind = state.kind === k ? '' : k
      kindChips.forEach(c => c.setAttribute('aria-pressed', String(c === chip && state.kind === k)))
      load()
    })
    return chip
  })
  const statusSeg = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Status' },
    ...['active', 'superseded', 'all'].map(s => {
      const b = h('button', { type: 'button', 'aria-pressed': String(s === state.status) }, s)
      b.addEventListener('click', () => {
        state.status = s
        ;[...statusSeg.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)))
        load()
      })
      return b
    }),
  )

  const sortSelect = h('select', { 'aria-label': 'Sort memories' },
    h('option', { value: 'recent' }, 'Newest first'),
    h('option', { value: 'oldest' }, 'Oldest first'),
    h('option', { value: 'importance' }, 'Most important first'),
  )
  sortSelect.value = state.sort
  sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; load() })

  /** The latest handoff, open; older ones folded. This is what the next agent is told first. */
  function handoffCard() {
    if (!handoffs.length) {
      return h('div', { class: 'card resume-card' }, h('div', { class: 'row tight' }, h('span', { class: 'kind k-handoff' }, 'handoff')), h('p', { class: 'dim', style: { margin: '8px 0 0' } }, 'No handoff yet. When an agent stops with work unfinished it writes one with cairn_handoff: what is done, in progress and next, what is blocked, and what was tried and dropped. The next agent, on any machine, starts from it.'))
    }
    const [latest, ...older] = handoffs
    const head = m => h('div', { class: 'row tight' }, h('span', { class: 'kind k-handoff' }, 'handoff'), m.topic && h('span', { class: 'tag' }, m.topic), h('span', { class: 'muted' }, ago(m.createdAt), m.machine && ` · ${m.machine}`, m.author && ` · ${m.author}`))
    return h('div', { class: 'card resume-card' },
      h('div', { class: 'row' }, h('h2', { style: { fontSize: '15px' } }, 'Where we left off'), h('span', { class: 'grow' }), h('button', { class: 'btn sm', type: 'button', onclick: () => openMemory(id, latest.id, navigate) }, 'Open')),
      h('div', { style: { margin: '8px 0 10px' } }, head(latest), h('div', { style: { fontWeight: 620, marginTop: '6px' } }, latest.title)),
      renderNotes(latest.body),
      ...older.map(m => h('details', null, h('summary', null, m.title, h('span', { class: 'muted' }, ` · ${m.topic ?? ''} · `, ago(m.createdAt))), h('div', { style: { marginTop: '8px' } }, renderNotes(m.body)))),
    )
  }

  function sessionRow(x) {
    const asked = x.prompts[0]?.text
    return h('details', { class: 'session' },
      h('summary', null,
        h('div', { class: 'row tight' }, h('b', null, x.machine ?? 'unknown machine'), x.agent && h('span', { class: 'muted' }, `(${x.agent})`), x.branch && h('span', { class: 'tag' }, x.branch), x.head && h('span', { class: 'mono muted' }, x.head.slice(0, 7)), h('span', { class: 'grow' }), x.dirty.length > 0 && h('span', { class: 'badge auth', title: 'Files that were not committed when the session was last seen' }, `${x.dirty.length} uncommitted`), x.touched.length > 0 && h('span', { class: 'badge' }, `${x.touched.length} edited`), h('span', { class: 'muted' }, ago(x.updatedAt))),
        asked && h('div', { class: 'clamp' }, asked),
      ),
      h('div', { class: 'detail' },
        x.prompts.length > 0 && h('div', null, h('b', null, 'What the person asked'), h('ol', { class: 'notes-list' }, ...x.prompts.map(p => h('li', null, p.text)))),
        x.lastReply && h('div', null, h('b', null, "The agent's last message"), h('p', { class: 'notes-p' }, x.lastReply)),
        x.touched.length > 0 && h('div', null, h('b', null, 'Files edited'), h('div', { class: 'files' }, x.touched.join('  '))),
        x.commits.length > 0 && h('div', null, h('b', null, 'Commits'), h('ul', { class: 'notes-list' }, ...x.commits.map(c => h('li', { class: 'mono' }, c)))),
        x.dirty.length > 0 && h('div', null, h('b', null, 'Left uncommitted'), h('div', { class: 'files' }, x.dirty.join('  '))),
      ),
    )
  }

  function sessionsCard() {
    if (!sessions.length) return null
    return h('div', { class: 'card', style: { marginBottom: '14px' } },
      h('div', { class: 'row' }, h('h2', { style: { fontSize: '15px' } }, 'Recent sessions'), h('span', { class: 'hint' }, 'recorded automatically as the work happens')),
      h('div', { class: 'sessions' }, ...sessions.map(sessionRow)),
    )
  }

  // ---- who can see this project -------------------------------------------------
  const meId = (await api('state').catch(() => ({}))).userId
  const membersBox = h('div', { class: 'card', style: { marginBottom: '14px' } })
  const base = `projects/${encodeURIComponent(id)}`
  const ROLE_NOTE = { viewer: 'reads memories', editor: 'reads and writes memories', maintainer: 'also manages who has access', owner: 'everything, including deleting the project' }

  async function changeMembers(work, done) {
    try {
      members = (await work()).members
      if (done) toast(done)
      drawMembers()
    } catch (error) {
      toast(error.message)
      drawMembers()
    }
  }

  function memberRow(m) {
    const self = m.userId === meId
    const locked = m.role === 'owner' || !canManage
    const sel = h('select', { 'aria-label': `Access of ${m.username}`, disabled: locked }, ['viewer', 'editor', 'maintainer', ...(m.role === 'owner' ? ['owner'] : [])].map(r => h('option', { value: r, selected: r === m.role }, r)))
    sel.addEventListener('change', () => changeMembers(() => api(`${base}/members/${encodeURIComponent(m.userId)}`, { method: 'PUT', body: { role: sel.value } }), `${m.username} is now ${sel.value}`))
    return h(
      'div',
      { class: 'row member' },
      h('span', { class: 'avatar' }, m.username[0].toUpperCase()),
      h('div', { class: 'grow' }, h('b', null, m.username), self && h('span', { class: 'badge', style: { marginLeft: '8px' } }, 'you'), h('div', { class: 'hint' }, ROLE_NOTE[m.role])),
      sel,
      m.role !== 'owner' && (canManage || self) && h('button', { class: 'btn sm danger', type: 'button', onclick: () => leaveOrRemove(m, self) }, self ? 'Leave' : 'Remove'),
    )
  }

  async function leaveOrRemove(m, self) {
    if (!confirm(self ? `Leave ${detail.name}? You lose access until someone adds you again.` : `Remove ${m.username} from ${detail.name}?`)) return
    try {
      members = (await api(`${base}/members/${encodeURIComponent(m.userId)}`, { method: 'DELETE' })).members
      if (self) {
        toast(`You left ${detail.name}`)
        return navigate('#/projects')
      }
      toast(`${m.username} removed`)
      drawMembers()
    } catch (error) {
      toast(error.message)
    }
  }

  function transferDrawer() {
    const others = members.filter(m => m.role !== 'owner')
    const pick = h('select', { 'aria-label': 'New owner' }, others.map(m => h('option', { value: m.username }, m.username)))
    const go = h('button', { class: 'btn danger', type: 'button', disabled: !others.length }, 'Transfer ownership')
    go.addEventListener('click', async () => {
      go.disabled = true
      try {
        await api(`${base}/transfer`, { body: { username: pick.value } })
        closeDrawer()
        toast(`${pick.value} now owns ${detail.name}`)
        navigate('#/projects')
      } catch (error) {
        toast(error.message)
        go.disabled = false
      }
    })
    openDrawer(h('strong', null, 'Transfer ownership'), h('div', { class: 'stack' }, h('p', null, 'The new owner can delete the project and decides who has access. You stay on as a maintainer.'), others.length ? h('div', { class: 'field' }, h('label', null, 'New owner'), pick) : h('p', { class: 'dim' }, 'Add someone to the project first.'), go))
  }

  function addForm() {
    const name = h('input', { class: 'input', placeholder: 'Username', 'aria-label': 'Username to add', autocomplete: 'off', style: { width: '180px' } })
    const level = h('select', { 'aria-label': 'Access level' }, ['viewer', 'editor', 'maintainer'].map(r => h('option', { value: r, selected: r === 'editor' }, r)))
    const add = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Add')
    const form = h('form', { class: 'row tight', style: { marginTop: '12px' } }, name, level, add, h('span', { class: 'hint' }, 'They must already have an account: an admin invites people under Users.'))
    form.addEventListener('submit', async e => {
      e.preventDefault()
      if (!name.value.trim()) return
      add.disabled = true
      await changeMembers(() => api(`${base}/members`, { body: { username: name.value.trim(), role: level.value } }), `${name.value.trim()} added as ${level.value}`)
      add.disabled = false
    })
    return form
  }

  function drawMembers() {
    membersBox.replaceChildren(
      h('div', { class: 'row' }, h('h2', { style: { fontSize: '15px' } }, 'Who has access'), h('span', { class: 'hint' }, members.length > 1 ? 'private to these people' : 'private to you until you add someone'), h('span', { class: 'grow' }), isOwner && members.length > 1 && h('button', { class: 'btn sm', type: 'button', onclick: transferDrawer }, 'Transfer ownership')),
      h('div', { class: 'stack', style: { gap: '10px', marginTop: '10px' } }, ...members.map(memberRow)),
      canManage && addForm(),
    )
  }

  function memoryRow(m) {
    return h(
      'div',
      { class: ['mem', `k-${m.kind}`, m.status === 'superseded' && 'dead'], tabindex: '0', role: 'button', onclick: () => openMemory(id, m.id, navigate), onkeydown: e => e.key === 'Enter' && openMemory(id, m.id, navigate) },
      h('div', { class: 'stripe' }),
      h(
        'div',
        { class: 'inner' },
        h('div', { class: 'row tight' }, h('span', { class: `kind k-${m.kind}` }, m.kind), m.area && h('span', { class: 'tag' }, m.area), m.status === 'superseded' && h('span', { class: 'badge auth' }, 'superseded'), h('span', { class: 'grow' }), importance(m.importance), h('span', { class: 'muted mono', style: { fontSize: '11.5px' } }, `#${m.id.slice(0, 8)}`)),
        h('div', { class: 'title' }, m.title),
        h('div', { class: 'snippet' }, m.body),
        h('div', { class: 'meta' }, ago(m.createdAt), m.agent && h('span', null, `· ${m.agent}`), m.author && h('span', null, `· ${m.author}`), m.paths.length > 0 && h('span', null, `· ${m.paths.length} path${m.paths.length > 1 ? 's' : ''}`), m.commitSha && h('span', { class: 'mono' }, `· ${m.commitSha.slice(0, 7)}`)),
      ),
    )
  }

  async function load() {
    list.replaceChildren(...Array.from({ length: 3 }, () => h('div', { class: 'skeleton', style: { height: '86px', borderRadius: '12px' } })))
    try {
      const { memories } = await api(`memories?${qs({ project: id, kind: state.kind, area: state.area, status: state.status, q: state.q, sort: state.sort, limit: 100 })}`)
      count.textContent = `${memories.length}${memories.length === 100 ? '+' : ''} shown${state.q ? ' · ranked by relevance' : ''}`
      if (!memories.length) return list.replaceChildren(h('div', { class: 'card' }, emptyState('search', 'No memories match', 'Try another filter or clear the search.')))
      list.replaceChildren(...memories.map(memoryRow))
    } catch (error) {
      list.replaceChildren(h('p', { class: 'error' }, error.message))
    }
  }

  areaSelect.addEventListener('change', () => { state.area = areaSelect.value; load() })
  search.input.addEventListener('input', debounce(() => { state.q = search.input.value.trim(); load() }, 250))

  container.append(
    h(
      'div',
      { class: 'page-head' },
      h('div', null, h('div', { class: 'crumbs' }, h('a', { href: '#/projects' }, 'Projects'), ' /'), h('div', { class: 'row tight' }, h('h1', { style: { fontSize: '22px' } }, detail.name), role && h('span', { class: 'badge' }, role)), detail.name !== id && h('div', { class: 'mono muted', style: { fontSize: '12px' } }, id)),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => navigate(`#/graph?project=${encodeURIComponent(id)}`) }, icon('graph'), 'Open in graph'), isOwner && h('button', { class: 'btn danger', type: 'button', onclick: () => confirmDelete(id, detail, navigate) }, icon('trash'), 'Delete'), h('button', { class: 'btn', type: 'button', onclick: () => navigate(`#/access?project=${encodeURIComponent(id)}`) }, icon('link'), 'Connect an agent')),
    ),
    h(
      'div',
      { class: 'card', style: { marginBottom: '14px' } },
      h(
        'div',
        { class: 'row', style: { gap: '30px', marginBottom: '14px' } },
        h('div', { class: 'stat' }, h('b', null, fmt.int(detail.active)), h('span', null, 'active memories')),
        h('div', { class: 'stat' }, h('b', null, fmt.int(detail.superseded)), h('span', null, 'superseded')),
        h('div', { class: 'stat' }, h('b', null, fmt.int(detail.areas.length)), h('span', null, detail.areas.length === 1 ? 'area' : 'areas')),
        h('div', { class: 'stat' }, h('b', null, fmt.int(detail.remotes)), h('span', null, detail.remotes === 1 ? 'git remote' : 'git remotes')),
        h('div', { class: 'stat' }, h('b', null, fmt.ago(detail.createdAt).replace(' ago', '')), h('span', null, 'old')),
      ),
      kindBar(detail.counts),
    ),
    handoffCard(),
    sessionsCard(),
    membersBox,
    h('div', { class: 'toolbar' }, search.el, areaSelect, sortSelect, statusSeg, h('span', { class: 'grow' }), count),
    h('div', { class: 'row tight', style: { marginBottom: '14px' } }, ...kindChips),
    list,
  )
  drawMembers()
  await load()
}
