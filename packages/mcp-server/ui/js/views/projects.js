import { api } from '../api.js'
import { ago, emptyState, fmt, h, icon, KINDS, kindBar, kindLegend, searchBox, toast } from '../dom.js'
import { live } from '../store.js'

export async function mount(container, { navigate }) {
  const { projects } = await api('projects')
  const search = searchBox({ placeholder: 'Find a project…', 'aria-label': 'Find a project', style: { width: '240px' } })
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' } })

  const activeNow = id => {
    const p = live.stats?.projects.find(x => x.project === id)
    return p && Date.now() - Date.parse(p.lastSeen) < 5 * 60_000 ? p : null
  }

  function card(p) {
    const now = activeNow(p.id)
    const top = KINDS.filter(k => p.counts[k]).sort((a, b) => p.counts[b] - p.counts[a])
    return h(
      'a',
      { class: 'card lift', href: `#/projects/${encodeURIComponent(p.id)}`, style: { color: 'inherit', textDecoration: 'none', display: 'flex', flexDirection: 'column', gap: '14px' } },
      h('div', { class: 'row' }, h('h2', { class: 'mono grow', style: { overflowWrap: 'anywhere', fontSize: '15px' } }, p.id), now && h('span', { class: 'badge ok', title: `${now.requests} requests this session` }, h('span', { class: 'dot live' }), 'active')),
      h('div', { class: 'row', style: { alignItems: 'baseline', gap: '8px' } }, h('span', { style: { fontSize: '32px', fontWeight: 680, letterSpacing: '-0.025em' } }, fmt.int(p.active)), h('span', { class: 'muted' }, p.active === 1 ? 'memory' : 'memories')),
      kindBar(p.counts),
      h('div', { class: 'legend' }, top.slice(0, 4).map(k => h('span', null, h('i', { class: `sw k-${k}`, style: { background: 'var(--k)' } }), `${p.counts[k]} ${k}`)), top.length > 4 && h('span', { class: 'muted' }, `+${top.length - 4} more`)),
      h(
        'div',
        { class: 'row muted', style: { fontSize: '12px', marginTop: 'auto', paddingTop: '10px', borderTop: '1px solid var(--border)' } },
        h('span', null, p.lastMemoryAt ? ['updated ', ago(p.lastMemoryAt)] : 'no memories yet'),
        h('span', { class: 'grow' }),
        p.superseded > 0 && h('span', null, `${p.superseded} superseded`),
        h('span', null, `${p.remotes} remote${p.remotes === 1 ? '' : 's'}`),
        icon('arrow'),
      ),
    )
  }

  function draw() {
    const q = search.input.value.trim().toLowerCase()
    const shown = projects.filter(p => p.id.toLowerCase().includes(q))
    if (!shown.length) {
      return grid.replaceChildren(h('div', { class: 'card', style: { gridColumn: '1 / -1' } }, projects.length ? emptyState('search', 'No project matches') : emptyState('folder', 'No projects yet', 'Create one here, or run `cairn init` in a repository.')))
    }
    grid.replaceChildren(...shown.map(card))
  }
  search.input.addEventListener('input', draw)

  const idInput = h('input', { class: 'input mono', id: 'new-project', placeholder: 'project-id', maxlength: '64', 'aria-label': 'New project id' })
  const createBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Create')
  const form = h('form', { class: 'toolbar', style: { display: 'none' } }, h('label', { class: 'dim', for: 'new-project' }, 'New project id'), idInput, createBtn, h('span', { class: 'hint' }, 'Letters, digits, ".", "_" or "-"; up to 64 characters.'))
  const newBtn = h('button', { class: 'btn', type: 'button' }, icon('plus'), 'New project')
  newBtn.addEventListener('click', () => {
    form.style.display = form.style.display === 'none' ? '' : 'none'
    if (form.style.display === '') idInput.focus()
  })
  form.addEventListener('submit', async e => {
    e.preventDefault()
    createBtn.disabled = true
    try {
      const r = await api('projects', { body: { id: idInput.value } })
      if (!r.created) toast(`"${r.id}" already exists`)
      navigate(`#/projects/${encodeURIComponent(r.id)}`)
    } catch (error) {
      toast(error.message)
    } finally {
      createBtn.disabled = false
    }
  })

  container.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Projects'), h('div', { class: 'sub' }, `${projects.length} project${projects.length === 1 ? '' : 's'} in Agent Cairn`)), h('div', { class: 'row' }, search.el, newBtn)),
    form,
    h('div', { style: { marginBottom: '16px' } }, kindLegend()),
    grid,
  )
  draw()
  return live.subscribe(kind => kind === 'stats' && draw())
}
