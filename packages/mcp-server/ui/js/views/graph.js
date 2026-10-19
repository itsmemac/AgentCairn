import { api, qs } from '../api.js'
import { debounce, fmt, h, icon, KINDS, searchBox } from '../dom.js'
import { live } from '../store.js'
import { importance, openMemory } from './memoryDrawer.js'

const KIND_VAR = { overview: '--s1', decision: '--s2', convention: '--s3', gotcha: '--s4', checkpoint: '--s5', thread: '--s6', glossary: '--s7' }
// Seven kinds are more than hue alone can carry safely, so kind is also a shape.
const KIND_SHAPE = { overview: 'star', decision: 'diamond', convention: 'round-rectangle', gotcha: 'triangle', checkpoint: 'ellipse', thread: 'round-tag', glossary: 'pentagon' }
const KIND_GLYPH = { overview: '★', decision: '◆', convention: '▢', gotcha: '▲', checkpoint: '●', thread: '▰', glossary: '⬟' }
const WRITE_TOOLS = new Set(['cairn_remember', 'cairn_checkpoint', 'cairn_forget'])
const LABEL_ZOOM = 1.15

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

function loadCytoscape() {
  if (window.cytoscape) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/ui/vendor/cytoscape.js'
    script.onload = resolve
    script.onerror = () => reject(new Error('Could not load the graph library.'))
    document.head.append(script)
  })
}

function stylesheet() {
  const text = css('--text')
  const surface = css('--surface')
  const axis = css('--axis')
  const muted = css('--muted')
  const accent = css('--s1')
  const pink = css('--s5')
  return [
    { selector: 'node', style: { 'font-size': 11, color: text, 'font-family': css('--sans'), 'text-valign': 'bottom', 'text-margin-y': 6, 'text-wrap': 'ellipsis', 'text-max-width': 130, 'text-outline-color': surface, 'text-outline-width': 3, 'border-width': 0, 'overlay-opacity': 0, 'underlay-color': accent, 'underlay-opacity': 0, 'underlay-padding': 6, 'underlay-shape': 'ellipse', label: '' } },
    { selector: 'node[type="project"]', style: { label: 'data(label)', shape: 'ellipse', width: 64, height: 64, 'background-color': text, 'border-width': 6, 'border-color': accent, 'font-size': 13, 'font-weight': 700, 'text-max-width': 180, 'text-margin-y': 8, 'z-index': 10 } },
    { selector: 'node[type="area"]', style: { label: 'data(label)', shape: 'hexagon', width: 40, height: 40, 'background-color': css('--raised'), 'border-width': 2, 'border-color': muted, 'font-weight': 600, 'z-index': 5 } },
    { selector: 'node[type="remote"]', style: { shape: 'round-rectangle', width: 14, height: 14, 'background-color': muted, 'font-size': 10, color: muted } },
    { selector: 'node[type="memory"]', style: { width: 'mapData(importance, 1, 5, 15, 32)', height: 'mapData(importance, 1, 5, 15, 32)', 'border-width': 1.5, 'border-color': surface } },
    ...KINDS.map(kind => ({ selector: `node[kind="${kind}"]`, style: { 'background-color': css(KIND_VAR[kind]), shape: KIND_SHAPE[kind] } })),
    { selector: 'node[status="superseded"]', style: { opacity: 0.42, 'border-style': 'dashed', 'border-color': muted, 'border-width': 2 } },
    { selector: 'node.lbl', style: { label: 'data(label)' } },
    { selector: 'edge', style: { width: 1.2, 'line-color': axis, 'curve-style': 'bezier', opacity: 0.85 } },
    { selector: 'edge[type="HAS_AREA"]', style: { width: 2.4, 'line-color': muted } },
    { selector: 'edge[type="BELONGS_TO"]', style: { 'line-style': 'dotted', 'line-color': muted } },
    { selector: 'edge[type="SUPERSEDES"]', style: { 'line-style': 'dashed', 'line-color': pink, 'target-arrow-shape': 'triangle', 'target-arrow-color': pink, 'arrow-scale': 1.1, width: 1.8, 'curve-style': 'unbundled-bezier' } },
    { selector: '.dim', style: { opacity: 0.1 } },
    { selector: '.match', style: { 'border-width': 4, 'border-color': css('--warn-text'), label: 'data(label)' } },
    { selector: '.hidden', style: { display: 'none' } },
    { selector: ':selected', style: { 'border-width': 4, 'border-color': accent, 'underlay-opacity': 0.22, 'underlay-padding': 9, label: 'data(label)' } },
  ]
}

/** Layouts that put the project at the root, then its areas, then their memories. */
function layoutOptions(cy, name) {
  const roots = cy.nodes('[type="project"]')
  switch (name) {
    case 'radial':
      return { name: 'breadthfirst', roots, circle: true, directed: false, spacingFactor: 1.05, avoidOverlap: true, padding: 40, animate: false }
    case 'tree':
      return { name: 'breadthfirst', roots, circle: false, directed: false, spacingFactor: 1.15, avoidOverlap: true, padding: 40, animate: false }
    case 'force':
      return { name: 'cose', animate: false, randomize: true, nodeRepulsion: 12000, idealEdgeLength: 90, nodeOverlap: 24, gravity: 0.45, numIter: 1200, padding: 40 }
    default:
      return { name: 'grid', animate: false, padding: 40, avoidOverlap: true }
  }
}

const LAYOUT_LABELS = { radial: 'Radial', tree: 'Tree', force: 'Force', grid: 'Grid' }

export async function mount(container, { query, navigate }) {
  const [{ projects }] = await Promise.all([api('projects'), loadCytoscape()])
  let project = query.project ?? ''
  let layoutName = 'radial'
  let limit = 300
  let pulseOn = true
  let showSuperseded = true
  const hiddenKinds = new Set()
  let cy = null
  let refreshTimer = null

  // ---- toolbar -------------------------------------------------------------
  const projectSelect = h('select', { 'aria-label': 'Project' }, h('option', { value: '' }, 'All projects'), projects.map(p => h('option', { value: p.id }, `${p.name} · ${p.active}`)))
  projectSelect.value = project
  projectSelect.addEventListener('change', () => navigate(`#/graph${projectSelect.value ? `?project=${encodeURIComponent(projectSelect.value)}` : ''}`))

  const layoutSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' })
  for (const name of Object.keys(LAYOUT_LABELS)) {
    layoutSeg.append(h('button', { type: 'button', 'aria-pressed': String(name === layoutName), onclick: () => { layoutName = name; syncLayout(); runLayout(true) } }, LAYOUT_LABELS[name]))
  }
  const syncLayout = () => [...layoutSeg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(LAYOUT_LABELS)[i] === layoutName)))

  const limitSelect = h('select', { 'aria-label': 'How many memories to load' }, [100, 300, 600, 1000].map(n => h('option', { value: n }, `${n} memories`)))
  limitSelect.value = String(limit)
  limitSelect.addEventListener('change', () => { limit = Number(limitSelect.value); load() })

  const search = searchBox({ placeholder: 'Highlight nodes…', 'aria-label': 'Highlight nodes by title', style: { width: '190px' } })
  search.input.addEventListener('input', debounce(applySearch, 150))

  const pulseBtn = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', title: 'Flash nodes when an agent reads or writes them' }, icon('zap'), 'Live pulse')
  pulseBtn.addEventListener('click', () => { pulseOn = !pulseOn; pulseBtn.setAttribute('aria-pressed', String(pulseOn)) })

  const supBtn = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', title: 'Show memories that were replaced' }, 'Superseded')
  supBtn.addEventListener('click', () => { showSuperseded = !showSuperseded; supBtn.setAttribute('aria-pressed', String(showSuperseded)); applyFilters() })

  // ---- canvas --------------------------------------------------------------
  const canvas = h('div', { id: 'cy' })
  const hudEl = h('div', { class: 'graph-hud' })
  const kindChips = project
    ? KINDS.map(k => {
        const chip = h('button', { class: `chip kindchip k-${k}`, type: 'button', 'aria-pressed': 'true', title: `Show or hide ${k} memories` }, h('i', { class: 'sw' }), `${KIND_GLYPH[k]} ${k}`)
        chip.addEventListener('click', () => { hiddenKinds.has(k) ? hiddenKinds.delete(k) : hiddenKinds.add(k); chip.setAttribute('aria-pressed', String(!hiddenKinds.has(k))); applyFilters() })
        return chip
      })
    : []
  const zoomBy = factor => cy?.animate({ zoom: { level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 160 })
  const controls = h('div', { class: 'canvas-overlay br' },
    h('button', { class: 'btn icon sm', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.3) }, icon('zoomin')),
    h('button', { class: 'btn icon sm', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.3) }, icon('zoomout')),
    h('button', { class: 'btn icon sm', type: 'button', title: 'Fit to screen', 'aria-label': 'Fit to screen', onclick: fit }, icon('fit')),
  )
  const side = h('div', { class: 'card side' })

  container.append(
    h('div', { class: 'graph-page' },
      h('div', { class: 'page-head', style: { marginBottom: '14px' } },
        h('div', null, h('h1', null, 'Graph'), h('div', { class: 'sub' }, project ? `The memory tree of ${project}: project, its areas, and the memories filed under each.` : 'Every project, with its areas and git remotes. Pick a project to see its memories.')),
      ),
      h('div', { class: 'toolbar' }, projectSelect, layoutSeg, project && limitSelect, h('span', { class: 'grow' }), search.el, pulseBtn, project && supBtn),
      h('div', { class: 'graph-layout' },
        h('div', { class: 'canvas-wrap' }, canvas, kindChips.length > 0 && h('div', { class: 'canvas-overlay tl' }, ...kindChips), controls, hudEl),
        side,
      ),
    ),
  )

  // ---- graph ---------------------------------------------------------------
  const element = n => ({ group: 'nodes', data: { ...n.data, mid: n.data.id, id: n.id, label: n.label, type: n.type } })
  const edgeEl = e => ({ group: 'edges', data: { id: e.id, source: e.source, target: e.target, type: e.type } })

  function runLayout(doFit) {
    if (!cy) return
    const layout = cy.layout(layoutOptions(cy, layoutName))
    if (doFit) layout.one('layoutstop', fit)
    layout.run()
  }
  function fit() {
    cy?.animate({ fit: { eles: cy.elements(':visible'), padding: 48 } }, { duration: 260 })
  }
  function hud() {
    if (cy) hudEl.textContent = `${cy.nodes().length} nodes · ${cy.edges().length} edges · ${cy.zoom().toFixed(2)}×`
  }
  function syncLabels() {
    if (!cy) return
    const show = cy.zoom() >= LABEL_ZOOM
    cy.nodes('[type="memory"]').toggleClass('lbl', show)
  }

  function applyFilters() {
    if (!cy) return
    cy.batch(() => {
      cy.nodes().forEach(n => {
        const hide = (n.data('type') === 'memory' && hiddenKinds.has(n.data('kind'))) || (!showSuperseded && n.data('status') === 'superseded')
        n.toggleClass('hidden', hide)
      })
    })
  }
  function applySearch() {
    if (!cy) return
    const q = search.input.value.trim().toLowerCase()
    cy.batch(() => {
      cy.elements().removeClass('match dim')
      if (!q) return
      const hits = cy.nodes().filter(n => String(n.data('label')).toLowerCase().includes(q))
      cy.elements().not(hits).addClass('dim')
      hits.addClass('match')
    })
  }
  function pulse(node) {
    if (!pulseOn || node.empty()) return
    node.stop(true)
    node.style({ 'underlay-opacity': 0.6, 'underlay-padding': 4 })
    node.animate({ style: { 'underlay-opacity': 0, 'underlay-padding': 30 } }, { duration: 1200, easing: 'ease-out' })
  }

  async function load() {
    side.replaceChildren(h('div', { class: 'skeleton', style: { height: '22px', width: '60%' } }), h('div', { class: 'skeleton', style: { height: '90px', marginTop: '14px' } }))
    const graph = await api(`graph?${qs({ project, limit })}`)
    if (cy) cy.destroy()
    cy = window.cytoscape({ container: canvas, elements: [...graph.nodes.map(element), ...graph.edges.map(edgeEl)], style: stylesheet(), wheelSensitivity: 0.22, minZoom: 0.08, maxZoom: 4 })
    runLayout(true)
    applyFilters()
    hud()

    cy.on('tap', 'node', e => select(e.target))
    cy.on('tap', e => { if (e.target === cy) { cy.elements().removeClass('dim'); cy.elements().unselect(); drawSide(null, graph) } })
    cy.on('mouseover', 'node', e => {
      if (search.input.value.trim()) return
      const around = e.target.closedNeighborhood()
      cy.elements().not(around).addClass('dim')
      around.nodes('[type="memory"]').addClass('lbl')
    })
    cy.on('mouseout', 'node', () => { if (!search.input.value.trim()) { cy.elements().removeClass('dim'); syncLabels() } })
    cy.on('dbltap', 'node[type="memory"]', e => openMemory(project, e.target.data('mid'), navigate))
    cy.on('zoom', debounce(() => { syncLabels(); hud() }, 60))

    drawSide(null, graph)
    if (query.focus) {
      const target = cy.nodes('[type="memory"]').filter(n => n.data('mid').startsWith(query.focus))
      if (target.nonempty()) {
        select(target[0])
        target[0].select()
        cy.one('layoutstop', () => cy.animate({ center: { eles: target }, zoom: 1.7 }, { duration: 420 }))
        setTimeout(() => pulse(target), 700)
      }
    }
  }

  async function refresh() {
    if (!cy || !project) return
    const graph = await api(`graph?${qs({ project, limit })}`)
    const incoming = new Set(graph.nodes.map(n => n.id))
    const fresh = []
    cy.batch(() => {
      for (const n of graph.nodes) {
        const existing = cy.getElementById(n.id)
        if (existing.empty()) {
          const parent = graph.edges.map(e => (e.target === n.id ? e.source : e.source === n.id ? e.target : null)).find(id => id && cy.getElementById(id).nonempty())
          const origin = parent ? cy.getElementById(parent).position() : { x: cy.width() / 2, y: cy.height() / 2 }
          fresh.push(cy.add({ ...element(n), position: { x: origin.x + (Math.random() - 0.5) * 80, y: origin.y + (Math.random() - 0.5) * 80 } }))
        } else existing.data({ ...n.data, mid: n.data.id, label: n.label })
      }
      cy.nodes().forEach(n => { if (!incoming.has(n.id())) n.remove() })
      const ids = new Set(graph.edges.map(e => e.id))
      cy.edges().forEach(e => { if (!ids.has(e.id())) e.remove() })
      for (const e of graph.edges) if (cy.getElementById(e.id).empty()) cy.add(edgeEl(e))
    })
    if (fresh.length) {
      // lay out only the newcomers; everything else stays where the person left it
      const settled = cy.nodes().not(cy.collection(fresh.flatMap(f => f.toArray())))
      settled.lock()
      const layout = cy.layout({ ...layoutOptions(cy, 'force'), animate: true, animationDuration: 600, randomize: false, fit: false, numIter: 250 })
      layout.one('layoutstop', () => settled.unlock())
      layout.run()
      for (const n of fresh) setTimeout(() => pulse(n), 650)
    }
    applyFilters()
    syncLabels()
    hud()
  }

  function select(node) {
    cy.elements().removeClass('dim')
    drawSide(node)
  }

  /** What a node is connected to, grouped by role, so the tree reads as a tree. */
  function relations(node) {
    const groups = new Map()
    const add = (label, other) => groups.set(label, [...(groups.get(label) ?? []), other])
    for (const e of node.connectedEdges()) {
      const out = e.source().id() === node.id()
      const other = out ? e.target() : e.source()
      const type = e.data('type')
      if (type === 'HAS_AREA') add(out ? 'Areas' : 'Project', other)
      else if (type === 'HAS_MEMORY') add(out ? 'Memories' : other.data('type') === 'area' ? 'Area' : 'Project', other)
      else if (type === 'SUPERSEDES') add(out ? 'Replaces' : 'Replaced by', other)
      else if (type === 'BELONGS_TO') add(out ? 'Project' : 'Git remote', other)
    }
    return groups
  }

  function drawSide(node, graph) {
    if (!node) {
      const counts = cy ? { project: cy.nodes('[type="project"]').length, area: cy.nodes('[type="area"]').length, memory: cy.nodes('[type="memory"]').length } : {}
      return side.replaceChildren(
        h('div', { class: 'stack' },
          h('div', null, h('div', { class: 'eyebrow' }, project ? 'Project' : 'Overview'), h('h2', { style: { fontSize: '17px', marginTop: '4px' } }, project || 'All projects')),
          graph?.truncated && h('div', { class: 'callout warn' }, `Showing the ${limit} most important and recent memories. Raise the limit to see more.`),
          h('div', { class: 'row' }, ...Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => h('div', { class: 'stat', style: { marginRight: '14px' } }, h('b', null, fmt.int(n)), h('span', null, k === 'memory' ? 'memories' : `${k}${n === 1 ? '' : 's'}`)))),
          h('p', { class: 'dim', style: { margin: 0 } }, 'Click a node to inspect it and double-click a memory to open it. Hover to follow its branch; zoom in to read memory titles.'),
          h('h3', null, 'How to read it'),
          h('div', { class: 'legend-list' },
            h('div', null, h('span', { class: 'g' }, '◯'), 'project: the root'),
            h('div', null, h('span', { class: 'g' }, '⬢'), 'area: a branch of the project'),
            ...KINDS.map(k => h('div', { class: `k-${k}` }, h('span', { class: 'g', style: { color: 'var(--k)' } }, KIND_GLYPH[k]), k)),
            h('div', null, h('span', { class: 'g', style: { opacity: 0.45 } }, '◆'), 'faded, dashed: superseded'),
            h('div', null, h('span', { class: 'g', style: { color: 'var(--s5)' } }, '⇢'), 'newer replaces older'),
          ),
          h('p', { class: 'hint', style: { margin: 0 } }, 'Size is importance. With live pulse on, a node glows when an agent reads or writes it.'),
        ),
      )
    }
    const d = node.data()
    const rows = [
      h('div', { class: 'row tight' }, h('span', { class: 'badge' }, d.type), d.kind && h('span', { class: `kind k-${d.kind}` }, d.kind), d.status === 'superseded' && h('span', { class: 'badge auth' }, 'superseded')),
      h('h2', { style: { fontSize: '16px', overflowWrap: 'anywhere', lineHeight: 1.35 } }, d.label),
    ]
    if (d.type === 'memory') {
      rows.push(h('div', { class: 'row' }, importance(d.importance), h('span', { class: 'muted mono' }, `#${d.mid.slice(0, 8)}`), h('span', { class: 'muted' }, fmt.ago(d.createdAt))), h('button', { class: 'btn', type: 'button', onclick: () => openMemory(project, d.mid, navigate) }, 'Open memory', icon('arrow')))
    } else if (d.type === 'project') {
      rows.push(h('div', { class: 'row' }, h('a', { class: 'btn', href: `#/projects/${encodeURIComponent(d.mid)}` }, 'Open project'), h('a', { class: 'btn', href: `#/graph?project=${encodeURIComponent(d.mid)}` }, 'Explore memories')))
    } else if (d.type === 'area') {
      rows.push(h('div', { class: 'dim' }, `${d.memories} active ${d.memories === 1 ? 'memory' : 'memories'} in ${d.project}`), h('a', { class: 'btn', href: `#/projects/${encodeURIComponent(d.project)}` }, 'Browse the project'))
    } else if (d.type === 'remote') {
      rows.push(h('div', { class: 'dim' }, 'A git remote that maps to this project, stored as a hash.'), h('div', { class: 'mono muted' }, d.hash))
    }
    for (const [label, others] of relations(node)) {
      rows.push(h('h3', null, label), h('div', { class: 'stack', style: { gap: '3px' } }, ...others.slice(0, 8).map(other => h('a', { href: '#', onclick: ev => { ev.preventDefault(); other.select(); select(other); cy.animate({ center: { eles: other } }, { duration: 250 }) } }, other.data('label'))), others.length > 8 && h('span', { class: 'muted' }, `+${others.length - 8} more`)))
    }
    side.replaceChildren(h('div', { class: 'stack' }, ...rows.filter(Boolean)))
  }

  // ---- live ----------------------------------------------------------------
  const unsubscribe = live.subscribe((kind, e) => {
    if (kind !== 'event' || !cy) return
    if (project && e.project !== project) return
    if (!project) return pulse(cy.getElementById(`p:${e.project}`))
    pulse(cy.getElementById(`p:${project}`))
    for (const ref of e.memoryRefs) {
      const nodes = cy.nodes('[type="memory"]').filter(n => n.data('mid').startsWith(ref))
      pulse(nodes)
      pulse(nodes.neighborhood('node[type="area"]'))
    }
    if (e.ok && WRITE_TOOLS.has(e.tool)) {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => refresh().catch(() => undefined), 700)
    }
  })

  const restyle = () => cy?.style(stylesheet())
  const observer = new MutationObserver(restyle)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', restyle)

  await load()
  return () => {
    unsubscribe()
    observer.disconnect()
    media.removeEventListener('change', restyle)
    clearTimeout(refreshTimer)
    cy?.destroy()
  }
}
