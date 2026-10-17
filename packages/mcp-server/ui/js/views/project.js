import { api, qs } from '../api.js'
import { ago, debounce, emptyState, fmt, h, icon, KINDS, kindBar, searchBox } from '../dom.js'
import { importance, openMemory } from './memoryDrawer.js'

export async function mount(container, { params, navigate }) {
  const id = params.id
  const detail = await api(`projects/${encodeURIComponent(id)}`)
  const state = { kind: '', area: '', status: 'active', q: '' }

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
      const { memories } = await api(`memories?${qs({ project: id, kind: state.kind, area: state.area, status: state.status, q: state.q, limit: 100 })}`)
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
      h('div', null, h('div', { class: 'crumbs' }, h('a', { href: '#/projects' }, 'Projects'), ' /'), h('h1', { class: 'mono', style: { fontSize: '22px' } }, id)),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => navigate(`#/graph?project=${encodeURIComponent(id)}`) }, icon('graph'), 'Open in graph'), h('button', { class: 'btn', type: 'button', onclick: () => navigate(`#/access?project=${encodeURIComponent(id)}`) }, icon('link'), 'Connect an agent')),
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
    h('div', { class: 'toolbar' }, search.el, areaSelect, statusSeg, h('span', { class: 'grow' }), count),
    h('div', { class: 'row tight', style: { marginBottom: '14px' } }, ...kindChips),
    list,
  )
  await load()
}
