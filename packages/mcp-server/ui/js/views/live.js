import { ago, clear, debounce, emptyState, fmt, h, icon, searchBox, statusMark } from '../dom.js'
import { createThroughput, sparkline, throughputTable } from '../charts.js'
import { live } from '../store.js'
import { openEvent } from './eventDrawer.js'

const ONLINE_MS = 5 * 60_000
const FEED_LIMIT = 200

function tile(label, value, sub, spark) {
  return h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub), spark && h('div', { class: 'spark' }, spark))
}

export async function mount(container, { navigate }) {
  let paused = false
  let view = 'chart'
  const filter = { tool: '', errorsOnly: false, text: '' }
  const throughput = createThroughput()

  // ---- layout --------------------------------------------------------------
  const pill = h('span', { class: 'livepill' })
  const tiles = h('div', { class: 'tiles' })
  const chartHolder = h('div')
  const toolsBody = h('div')
  const clientsBody = h('div')
  const feedBody = h('tbody')
  const feedCount = h('span', { class: 'hint' })

  const toggle = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show chart or table' })
  for (const v of ['chart', 'table']) {
    toggle.append(h('button', { type: 'button', 'aria-pressed': String(v === view), onclick: () => { view = v; syncToggle(); drawChart() } }, v === 'chart' ? 'Chart' : 'Table'))
  }
  const syncToggle = () => [...toggle.children].forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === (view === 'chart'))))

  const toolSelect = h('select', { 'aria-label': 'Filter by tool' }, h('option', { value: '' }, 'All calls'))
  const search = searchBox({ placeholder: 'Filter project, client, tool…', 'aria-label': 'Filter the feed', style: { width: '230px' } })
  const errBtn = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false' }, icon('alert'), 'Errors only')
  const pauseBtn = h('button', { class: 'btn sm', type: 'button' }, icon('pause'), 'Pause')

  container.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Live'), h('div', { class: 'sub' }, 'Everything agents and tools send to this server, as it happens.')), pill),
    tiles,
    h(
      'div',
      { class: 'live-grid' },
      h(
        'div',
        { class: 'stack', style: { gap: '16px', minWidth: 0 } },
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'head' }, h('div', null, h('h2', null, 'Requests per minute'), h('div', { class: 'hint' }, 'Last 60 minutes')), h('div', { class: 'tools' }, h('div', { class: 'legend' }, h('span', null, h('i', { class: 'sw', style: { background: 'var(--s1)' } }), 'Requests'), h('span', null, h('i', { class: 'sw', style: { background: 'var(--crit)' } }), 'Errors and denied')), toggle)),
          chartHolder,
        ),
        h(
          'div',
          { class: 'card flush' },
          h('div', { class: 'head' }, h('div', null, h('h2', null, 'Feed'), feedCount), h('div', { class: 'tools' }, toolSelect, errBtn, search.el, pauseBtn)),
          h('div', { class: 'scroll feed', style: { maxHeight: '640px' } }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['', 'Time', 'Call', 'Client', 'Took', 'Tokens'].map((t, i) => h('th', { class: i >= 4 ? 'num' : '' }, t)))), feedBody)),
        ),
      ),
      h(
        'div',
        { class: 'rail' },
        h('div', { class: 'card flush' }, h('div', { class: 'head' }, h('div', null, h('h2', null, 'Tools'), h('div', { class: 'hint' }, 'count and p50 / p95 latency'))), toolsBody),
        h('div', { class: 'card flush' }, h('div', { class: 'head' }, h('div', null, h('h2', null, 'Clients'), h('div', { class: 'hint' }, 'online = seen in the last 5 minutes'))), clientsBody),
      ),
    ),
  )

  // ---- drawing -------------------------------------------------------------
  function drawChart() {
    clear(chartHolder)
    if (view === 'chart') {
      chartHolder.append(throughput.el)
      if (live.stats) throughput.update(live.stats.perMinute)
    } else chartHolder.append(throughputTable(live.stats?.perMinute ?? []))
  }

  function drawPill() {
    const s = live.stats
    pill.replaceChildren(h('span', { class: `dot ${live.status === 'live' ? 'live' : live.status === 'down' ? 'down' : ''}` }), s ? `up ${fmt.uptime(s.uptimeSeconds)} · ${s.viewers} watching` : 'connecting…')
  }

  function drawTiles() {
    const s = live.stats
    if (!s) return tiles.replaceChildren(...Array.from({ length: 5 }, () => h('div', { class: 'tile' }, h('div', { class: 'skeleton', style: { height: '14px', width: '60%' } }), h('div', { class: 'skeleton', style: { height: '30px', width: '40%', marginTop: '10px' } }))))
    const lastMinute = s.perMinute.at(-1)?.requests ?? 0
    const online = s.clients.filter(c => c.active).length
    const touched = s.projects.filter(p => Date.now() - Date.parse(p.lastSeen) < ONLINE_MS).length
    const rate = s.totals.requests ? (s.totals.errors / s.totals.requests) * 100 : 0
    tiles.replaceChildren(
      tile('Requests', fmt.int(s.totals.requests), `${lastMinute} in the last minute`, sparkline(s.perMinute.slice(-30).map(m => m.requests))),
      tile('Clients online', String(online), `${s.clients.length} seen since start`),
      tile('Projects active', String(touched), `${s.projects.length} seen since start`),
      tile('Tokens served', fmt.num(s.totals.tokensOut), s.totals.requests ? `≈ ${fmt.int(s.totals.tokensOut / s.totals.requests)} per request (est.)` : 'estimated at 4 characters a token', sparkline(s.perMinute.slice(-30).map(m => m.tokensOut))),
      tile('Errors', fmt.int(s.totals.errors), `${rate.toFixed(1)}% of requests · ${s.totals.authFailures} denied`),
    )
  }

  function drawTools() {
    const tools = live.stats?.tools ?? []
    if (!tools.length) return toolsBody.replaceChildren(emptyState('zap', 'No tool calls yet', 'They appear here as agents use the brain.'))
    const max = Math.max(...tools.map(t => t.count))
    toolsBody.replaceChildren(
      h('div', { class: 'list' }, tools.map(t => h('div', { class: 'toolrow', role: 'button', tabindex: '0', title: 'Filter the feed to this tool', onclick: () => pickTool(t.name), onkeydown: e => e.key === 'Enter' && pickTool(t.name) },
        h('div', { class: 'row' }, h('b', { class: 'mono' }, t.name), h('span', { class: 'grow' }), t.errors > 0 && h('span', { class: 'badge err' }, icon('x'), String(t.errors)), h('span', { class: 'num' }, fmt.int(t.count))),
        h('div', { class: 'meter' }, h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${Math.max(2, (t.count / max) * 100)}%` } })), h('span', { class: 'hint mono nowrap' }, `${fmt.ms(t.p50Ms)} / ${fmt.ms(t.p95Ms)}`)),
      ))),
    )
    const have = new Set([...toolSelect.options].map(o => o.value))
    for (const t of tools) if (!have.has(t.name)) toolSelect.append(h('option', { value: t.name }, t.name))
  }

  function drawClients() {
    const clients = live.stats?.clients ?? []
    if (!clients.length) return clientsBody.replaceChildren(emptyState('inbox', 'No agent has connected yet', 'Create a token under Access and point Claude at this server.'))
    clientsBody.replaceChildren(
      h('div', { class: 'list' }, clients.map(c => h('div', { class: 'toolrow client', role: 'button', tabindex: '0', title: 'Filter the feed to this client', onclick: () => pickClient(c), onkeydown: e => e.key === 'Enter' && pickClient(c) },
        h('span', { class: `dot ${c.active ? 'live' : ''}`, title: c.active ? 'online' : 'idle' }),
        h('div', { class: 'who' }, h('b', null, c.token ?? 'unnamed'), h('span', null, [c.agent, c.ip, c.lastProject].filter(Boolean).join(' · '))),
        h('div', { style: { textAlign: 'right' } }, h('div', { class: 'hint' }, ago(c.lastSeen)), h('div', { class: 'num dim', style: { fontSize: '12px' } }, `${fmt.int(c.requests)} req`)),
      ))),
    )
  }

  function pickTool(name) {
    filter.tool = name
    toolSelect.value = name
    drawFeed()
  }
  function pickClient(c) {
    search.input.value = c.token ?? c.ip ?? ''
    filter.text = search.input.value.toLowerCase()
    drawFeed()
  }

  const matches = e => {
    if (filter.tool && e.tool !== filter.tool && e.method !== filter.tool) return false
    if (filter.errorsOnly && e.ok) return false
    if (filter.text) {
      const hay = `${e.tool ?? ''} ${e.method} ${e.project ?? ''} ${e.client.token ?? ''} ${e.client.agent ?? ''} ${e.client.ip ?? ''}`.toLowerCase()
      if (!hay.includes(filter.text)) return false
    }
    return true
  }

  function row(e, fresh) {
    const refs = e.memoryRefs.length
    return h('tr', { class: ['rowlink', fresh && 'fresh'], tabindex: '0', onclick: () => openEvent(e, navigate), onkeydown: ev => ev.key === 'Enter' && openEvent(e, navigate) },
      h('td', { style: { width: '1%', paddingRight: 0 } }, statusMark(e)),
      h('td', { class: 'mono nowrap muted', title: fmt.dateTime(e.ts) }, fmt.clock(e.ts)),
      h('td', null, e.tool ? h('span', { class: 'tool-name mono' }, e.tool) : h('span', { class: 'method dim' }, e.method), refs > 0 && h('span', { class: 'tag', style: { marginLeft: '8px' }, title: `${refs} memories touched` }, `◈ ${refs}`), h('span', { class: 'sub mono' }, e.project ?? '–')),
      h('td', null, e.client.token ?? h('span', { class: 'muted' }, 'unauthenticated'), e.client.agent && h('span', { class: 'sub' }, e.client.agent)),
      h('td', { class: 'num mono' }, fmt.ms(e.durationMs)),
      h('td', { class: 'num' }, e.tokensOut ? fmt.int(e.tokensOut) : h('span', { class: 'muted' }, '–')),
    )
  }

  function drawFeed() {
    const shown = live.events.filter(matches).slice(0, FEED_LIMIT)
    feedCount.textContent = live.events.length ? `${shown.length}${shown.length === FEED_LIMIT ? '+' : ''} shown` : ''
    if (!shown.length) {
      return feedBody.replaceChildren(h('tr', null, h('td', { colspan: 6 }, live.events.length ? emptyState('search', 'Nothing matches the filter') : emptyState('live', 'Waiting for the first request…', 'Requests from agents and the CLI appear here the moment they arrive.'))))
    }
    feedBody.replaceChildren(...shown.map(e => row(e, false)))
  }

  // ---- wiring --------------------------------------------------------------
  toolSelect.addEventListener('change', () => { filter.tool = toolSelect.value; drawFeed() })
  search.input.addEventListener('input', debounce(() => { filter.text = search.input.value.trim().toLowerCase(); drawFeed() }, 150))
  errBtn.addEventListener('click', () => { filter.errorsOnly = !filter.errorsOnly; errBtn.setAttribute('aria-pressed', String(filter.errorsOnly)); drawFeed() })
  pauseBtn.addEventListener('click', () => {
    paused = !paused
    pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause'), paused ? 'Resume' : 'Pause')
    if (!paused) drawFeed()
  })

  const unsubscribe = live.subscribe((kind, payload) => {
    if (kind === 'status') drawPill()
    if (kind === 'stats') {
      drawPill()
      drawTiles()
      drawTools()
      drawClients()
      if (view === 'chart') throughput.update(live.stats.perMinute)
      else drawChart()
    }
    if (kind === 'event' && !paused && matches(payload)) {
      if (feedBody.firstChild?.firstChild?.colSpan > 1) feedBody.replaceChildren()
      feedBody.prepend(row(payload, true))
      while (feedBody.children.length > FEED_LIMIT) feedBody.lastChild.remove()
      feedCount.textContent = `${feedBody.children.length} shown`
    }
  })

  drawPill()
  drawChart()
  drawTiles()
  drawTools()
  drawClients()
  drawFeed()
  return unsubscribe
}
