import { api, qs } from '../api.js'
import { debounce, fmt, h, icon, KINDS, searchBox, svg } from '../dom.js'
import { live } from '../store.js'
import { importance, openMemory } from './memoryDrawer.js'

const KIND_VAR = { handoff: '--s8', overview: '--s1', decision: '--s2', convention: '--s3', gotcha: '--s4', checkpoint: '--s5', thread: '--s6', glossary: '--s7' }
// Seven kinds are more than hue alone can carry safely, so kind is also a shape.
const KIND_SHAPE = { handoff: 'octagon', overview: 'star', decision: 'diamond', convention: 'round-rectangle', gotcha: 'triangle', checkpoint: 'ellipse', thread: 'round-tag', glossary: 'pentagon' }
// each node's outline as a 16x16 icon, for the pills, kept in step with KIND_SHAPE
const SHAPE_PATH = {
  octagon: 'M5 1.5h6L14.5 5v6L11 14.5H5L1.5 11V5z',
  star: 'M8 1l2 5 5 .2-3.9 3.3L12.5 15 8 12l-4.5 3 1.4-5.5L1 6.2l5-.2z',
  diamond: 'M8 1l7 7-7 7-7-7z',
  'round-rectangle': 'M5 3h6a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z',
  triangle: 'M8 2l7 12H1z',
  ellipse: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z',
  'round-tag': 'M2 3h9l4 5-4 5H2z',
  pentagon: 'M8 1.5l6.5 4.7L12 14H4L1.5 6.2z',
  hexagon: 'M4.5 2h7L15 8l-3.5 6h-7L1 8z',
}
function shapeIcon(type, kind) {
  const shape = type === 'memory' ? KIND_SHAPE[kind] : type === 'area' ? 'hexagon' : 'ellipse'
  return svg('svg', { class: 'shape', viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true' }, svg('path', { d: SHAPE_PATH[shape] ?? SHAPE_PATH.ellipse, fill: 'currentColor' }))
}
const WRITE_TOOLS = new Set(['cairn_remember', 'cairn_checkpoint', 'cairn_handoff', 'cairn_forget'])

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

/** Black or white caption, whichever reads better on this fill. */
function inkOn(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return '#ffffff'
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#141415' : '#ffffff'
}
/** The fill colour of a kind, project or area: what the chips in the side panel use too. */
export function nodeColor(type, kind) {
  if (type === 'project') return css('--text')
  if (type === 'area') return css('--text-2')
  if (type === 'remote') return css('--muted')
  return css(KIND_VAR[kind] ?? '--s1')
}
/** Mixes two #rrggbb colours (cytoscape does not understand color-mix). */
function mix(a, b, amount) {
  const p = c => [1, 3, 5].map(i => parseInt(c.replace('#', '').padEnd(6, '0').slice(i - 1, i + 1), 16))
  const [x, y] = [p(a), p(b)]
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * amount).toString(16).padStart(2, '0')).join('')}`
}
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

function stylesheet() {
  const surface = css('--surface')
  const muted = css('--muted')
  const accent = css('--s1')
  const pink = css('--s5')
  const page = css('--page')
  const circle = (type, kind) => {
    const fill = nodeColor(type, kind)
    return { 'background-color': fill, color: type === 'project' || type === 'area' ? page : inkOn(fill), 'border-color': mix(fill, type === 'project' || type === 'area' ? page : '#000000', 0.3) }
  }
  return [
    { selector: 'node', style: { shape: 'ellipse', label: 'data(caption)', 'font-size': 9, 'font-weight': 600, color: '#fff', 'font-family': css('--sans'), 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 46, 'line-height': 1.15, 'min-zoomed-font-size': 7, 'border-width': 2, 'overlay-opacity': 0, 'underlay-color': accent, 'underlay-opacity': 0, 'underlay-padding': 6, 'underlay-shape': 'ellipse' } },
    { selector: 'node[type="project"]', style: { ...circle('project'), width: 84, height: 84, 'font-size': 12, 'font-weight': 700, 'text-max-width': 70, 'z-index': 10 } },
    { selector: 'node[type="area"]', style: { ...circle('area'), shape: 'hexagon', width: 66, height: 66, 'font-size': 10, 'text-max-width': 52, 'z-index': 5 } },
    { selector: 'node[type="remote"]', style: { ...circle('remote'), width: 34, height: 34, 'font-size': 8, 'text-max-width': 30 } },
    { selector: 'node[type="memory"]', style: { width: 'mapData(importance, 1, 5, 44, 66)', height: 'mapData(importance, 1, 5, 44, 66)', 'text-max-width': 48 } },
    ...KINDS.map(kind => ({ selector: `node[kind="${kind}"]`, style: { ...circle('memory', kind), shape: KIND_SHAPE[kind] } })),
    { selector: 'node[kind="decision"], node[kind="gotcha"], node[kind="overview"]', style: { width: 'mapData(importance, 1, 5, 58, 84)', height: 'mapData(importance, 1, 5, 58, 84)', 'text-max-width': 40, 'font-size': 8 } },
    { selector: 'node[kind="gotcha"]', style: { 'text-margin-y': 7 } },
    { selector: 'node[kind="glossary"], node[kind="handoff"], node[kind="thread"]', style: { width: 'mapData(importance, 1, 5, 48, 70)', height: 'mapData(importance, 1, 5, 48, 70)' } },
    { selector: 'node[status="superseded"]', style: { opacity: 0.45, 'border-style': 'dashed', 'border-color': muted, 'border-width': 2 } },
    { selector: 'edge', style: { width: 1.1, 'line-color': muted, opacity: 0.75, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'target-arrow-color': muted, 'arrow-scale': 0.8, label: 'data(type)', 'font-size': 8, color: muted, 'font-family': css('--sans'), 'text-rotation': 'autorotate', 'text-background-color': surface, 'text-background-opacity': 1, 'text-background-padding': 2, 'min-zoomed-font-size': 8, 'text-margin-y': -1 } },
    { selector: 'edge[type="BELONGS_TO"]', style: { 'line-style': 'dotted' } },
    { selector: 'edge[type="SUPERSEDES"]', style: { 'line-style': 'dashed', 'line-color': pink, 'target-arrow-color': pink, color: pink, width: 1.6, 'curve-style': 'unbundled-bezier' } },
    { selector: '.dim', style: { opacity: 0.12 } },
    { selector: '.match', style: { 'border-width': 4, 'border-color': css('--warn-text'), 'underlay-color': css('--warn-text'), 'underlay-opacity': 0.25, 'underlay-padding': 7 } },
    { selector: '.hidden', style: { display: 'none' } },
    { selector: '.collapsed', style: { display: 'none' } },
    { selector: 'node[type="project"].sized', style: { width: 'mapData(memories, 0, 120, 104, 160)', height: 'mapData(memories, 0, 120, 104, 160)', 'font-size': 12, 'text-max-width': 90 } },
    { selector: 'node[type="project"].quiet', style: { opacity: 0.6 } },
    { selector: 'node[type="project"].away', style: { opacity: 0.25 } },
    { selector: 'node[type="project"].open', style: { 'underlay-opacity': 0.16, 'underlay-padding': 12 } },
    { selector: ':selected', style: { 'border-width': 3, 'border-color': accent, 'underlay-opacity': 0.28, 'underlay-padding': 9 } },
    { selector: 'edge:selected', style: { width: 2.2, 'line-color': accent, 'target-arrow-color': accent, opacity: 1 } },
  ]
}

/** Layouts that put the project at the root, then its areas, then their memories. */
function layoutOptions(cy, name, overview = false) {
  const roots = cy.nodes('[type="project"]')
  switch (name) {
    case 'radial':
      if (overview) return { name: 'concentric', concentric: n => n.data('memories') ?? 0, levelWidth: () => 25, minNodeSpacing: 90, spacingFactor: 1.3, avoidOverlap: true, padding: 40, animate: false }
      return { name: 'breadthfirst', roots, circle: true, directed: false, spacingFactor: 1.05, avoidOverlap: true, padding: 40, animate: false }
    case 'tree':
      return { name: 'breadthfirst', roots, circle: false, directed: false, spacingFactor: 1.15, avoidOverlap: true, padding: 40, animate: false }
    case 'force':
      return { name: 'cose', animate: false, randomize: true, nodeRepulsion: 16000, idealEdgeLength: 110, nodeOverlap: 30, gravity: 0.35, numIter: 1200, nodeDimensionsIncludeLabels: false, padding: 40 }
    default:
      return { name: 'grid', animate: false, padding: 40, avoidOverlap: true }
  }
}

const LAYOUT_LABELS = { radial: 'Radial', tree: 'Tree', force: 'Force', grid: 'Grid' }
const FEW_PROJECTS = 3 // up to this many, their areas are shown straight away
const QUIET_AFTER_DAYS = 21

export async function mount(container, { query, navigate }) {
  const [{ projects }] = await Promise.all([api('projects'), loadCytoscape()])
  let project = query.project ?? ''
  let layoutName = query.project ? 'force' : 'radial'
  let limit = 300
  let pulseOn = true
  let showSuperseded = true
  let pinnedAreas = false // overview: keep every project's areas open
  let showRemotes = false
  const expanded = new Set()
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

  const areasBtn = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', title: 'Open every project to show its areas' }, 'Areas')
  areasBtn.addEventListener('click', () => {
    pinnedAreas = !pinnedAreas
    areasBtn.setAttribute('aria-pressed', String(pinnedAreas))
    pinnedAreas ? expandAll() : collapseAll()
    fit()
  })
  const remotesBtn = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', title: 'Show the git remotes that map to each project' }, 'Git remotes')
  remotesBtn.addEventListener('click', () => {
    showRemotes = !showRemotes
    remotesBtn.setAttribute('aria-pressed', String(showRemotes))
    cy?.nodes('[type="remote"]').toggleClass('collapsed', !showRemotes)
    hud()
  })

  const supBtn = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', title: 'Show memories that were replaced' }, 'Superseded')
  supBtn.addEventListener('click', () => { showSuperseded = !showSuperseded; supBtn.setAttribute('aria-pressed', String(showSuperseded)); applyFilters() })

  // ---- canvas --------------------------------------------------------------
  const canvas = h('div', { id: 'cy' })
  const hudEl = h('div', { class: 'graph-hud' })
  const kindChips = project
    ? KINDS.map(k => {
        const chip = h('button', { class: `chip kindchip k-${k}`, type: 'button', 'aria-pressed': 'true', title: `Show or hide ${k} memories` }, shapeIcon('memory', k), k)
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
        h('div', null, h('h1', null, 'Graph'), h('div', { class: 'sub' }, project ? `The memory tree of ${project}: project, its areas, and the memories filed under each.` : 'Every project, sized by how much it remembers. Click one to open its areas; double-click to explore its memories.')),
      ),
      h('div', { class: 'toolbar' }, projectSelect, layoutSeg, project && limitSelect, h('span', { class: 'grow' }), search.el, !project && areasBtn, !project && remotesBtn, pulseBtn, project && supBtn),
      h('div', { class: 'graph-layout' },
        h('div', { class: 'canvas-wrap' }, canvas, kindChips.length > 0 && h('div', { class: 'canvas-overlay tl' }, ...kindChips), controls, hudEl),
        side,
      ),
    ),
  )

  // ---- graph ---------------------------------------------------------------
  const caption = n => (n.type === 'project' ? shorten(n.label, 18) : n.type === 'area' ? shorten(n.label, 14) : n.type === 'remote' ? shorten(n.label, 8) : shorten(n.label, 30))
  const element = n => ({ group: 'nodes', data: { ...n.data, mid: n.data.id, id: n.id, label: n.label, caption: caption(n), type: n.type } })
  const edgeEl = e => ({ group: 'edges', data: { id: e.id, source: e.source, target: e.target, type: e.type } })

  function runLayout(doFit) {
    if (!cy) return
    const overview = !project
    const eles = overview ? cy.nodes('[type="project"]') : cy.elements()
    const layout = eles.layout(layoutOptions(cy, layoutName, overview))
    if (doFit) layout.one('layoutstop', fit)
    layout.run()
  }
  function fit() {
    cy?.animate({ fit: { eles: cy.elements(':visible'), padding: 48 } }, { duration: 260 })
  }
  function hud() {
    if (!cy) return
    // what is drawn: folded-away and filtered nodes are not counted
    const shown = n => !n.is('.collapsed, .hidden')
    const nodes = cy.nodes().filter(shown).length
    const edges = cy.edges().filter(e => shown(e.source()) && shown(e.target())).length
    hudEl.textContent = `${nodes} nodes · ${edges} edges · ${cy.zoom().toFixed(2)}×`
  }

  /** The areas of a project fan out around it; everything else stays put. */
  function expand(node, animate = true) {
    if (node.data('type') !== 'project') return
    const areas = node.outgoers('node[type="area"]')
    const center = node.position()
    const radius = 84 + areas.length * 8
    areas.forEach((a, i) => {
      const angle = (2 * Math.PI * i) / Math.max(areas.length, 1) - Math.PI / 2
      const spot = { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
      a.removeClass('collapsed')
      if (animate) {
        a.position(center)
        a.animate({ position: spot }, { duration: 240, easing: 'ease-out' })
      } else a.position(spot)
    })
    node.addClass('open')
    expanded.add(node.id())
    hud()
  }
  function collapse(node) {
    node.outgoers('node[type="area"]').addClass('collapsed')
    node.removeClass('open')
    expanded.delete(node.id())
    hud()
  }
  const expandAll = () => cy?.nodes('[type="project"]').forEach(n => expand(n, false))
  const collapseAll = () => {
    cy?.nodes('[type="project"]').forEach(collapse)
    cy?.nodes('[type="project"]').removeClass('away')
  }
  function toggleExpand(node) {
    if (pinnedAreas) return
    const wasOpen = expanded.has(node.id())
    collapseAll()
    if (!wasOpen) {
      expand(node)
      // the rest step back while one is open
      cy.nodes('[type="project"]').not(node).addClass('away')
    }
  }
  /** Many projects at once is a lot to draw: start with just the projects, and let people open them. */
  function prepareOverview() {
    const cutoff = Date.now() - QUIET_AFTER_DAYS * 86_400_000
    cy.nodes('[type="project"]').forEach(n => {
      n.addClass('sized')
      n.toggleClass('quiet', Date.parse(n.data('lastMemoryAt') ?? n.data('createdAt')) < cutoff)
    })
    cy.nodes('[type="area"]').addClass('collapsed')
    cy.nodes('[type="remote"]').addClass('collapsed')
    expanded.clear()
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
    if (!project) prepareOverview()
    runLayout(true)
    if (!project && cy.nodes('[type="project"]').length <= FEW_PROJECTS) expandAll()
    applyFilters()
    hud()

    cy.on('tap', 'node', e => {
      select(e.target)
      if (!project && e.target.data('type') === 'project') toggleExpand(e.target)
    })
    cy.on('dbltap', 'node[type="project"]', e => { if (!project) navigate(`#/graph?project=${encodeURIComponent(e.target.data('mid'))}`) })
    cy.on('tap', e => {
      if (e.target !== cy) return
      cy.elements().removeClass('dim')
      cy.elements().unselect()
      if (!project && !pinnedAreas) collapseAll()
      drawSide(null, graph)
    })
    cy.on('mouseover', 'node', e => {
      if (search.input.value.trim()) return
      const around = e.target.closedNeighborhood()
      cy.elements().not(around).addClass('dim')
    })
    cy.on('mouseout', 'node', () => { if (!search.input.value.trim()) { cy.elements().removeClass('dim') } })
    cy.on('dbltap', 'node[type="memory"]', e => openMemory(project, e.target.data('mid'), navigate))
    cy.on('zoom', debounce(hud, 60))

    drawSide(null, graph)
    if (!project && query.focus) {
      // a link like #/graph?focus=<project id> opens that project's areas
      const target = cy.getElementById(`p:${query.focus}`)
      if (target.nonempty()) {
        select(target)
        toggleExpand(target)
        target.select()
      }
    }
    if (project && query.focus) {
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
        } else existing.data({ ...n.data, mid: n.data.id, label: n.label, caption: caption(n) })
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

  /** Like Neo4j Browser's overview: one coloured pill per node label and one per relationship type. */
  let focusedLabel = null
  function highlightLabel(name) {
    if (!cy) return
    focusedLabel = focusedLabel === name ? null : name
    cy.batch(() => {
      cy.elements().removeClass('dim')
      if (!focusedLabel) return
      const hits = cy.nodes().filter(n => (n.data('type') === 'memory' ? n.data('kind') : n.data('type')) === focusedLabel)
      cy.elements().not(hits).addClass('dim')
    })
    drawSide(null)
  }
  function labelChips() {
    if (!cy) return []
    const counts = new Map()
    for (const n of cy.nodes()) {
      const name = n.data('type') === 'memory' ? n.data('kind') : n.data('type')
      const entry = counts.get(name) ?? { n: 0, type: n.data('type'), kind: n.data('kind') }
      entry.n += 1
      counts.set(name, entry)
    }
    return [...counts].map(([name, c]) => {
      const fill = nodeColor(c.type, c.kind)
      return h('button', { type: 'button', class: 'nlabel', 'aria-pressed': String(focusedLabel === name), style: { background: fill, color: inkOn(fill) }, onclick: () => highlightLabel(name) }, shapeIcon(c.type, c.kind), name, h('span', { class: 'n' }, fmt.int(c.n)))
    })
  }
  function relationshipChips() {
    if (!cy) return []
    const counts = new Map()
    for (const e of cy.edges()) counts.set(e.data('type'), (counts.get(e.data('type')) ?? 0) + 1)
    return [...counts].map(([name, n]) => h('span', { class: 'rlabel' }, name, h('span', { class: 'n' }, fmt.int(n))))
  }

  /** The node's own fields, the way Neo4j Browser lists properties. */
  function propertyTable(d) {
    const skip = new Set(['id', 'mid', 'label', 'caption', 'type', 'memories', 'areas'])
    const rows = [['id', d.mid], ...Object.entries(d).filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== '')]
    return h('table', { class: 'props' }, h('tbody', null, rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, typeof v === 'object' ? JSON.stringify(v) : String(v))))))
  }

  function drawSide(node, graph) {
    if (!node) {
      const counts = cy ? { project: cy.nodes('[type="project"]').length, area: cy.nodes('[type="area"]').length, memory: cy.nodes('[type="memory"]').length } : {}
      return side.replaceChildren(
        h('div', { class: 'stack' },
          h('div', null, h('div', { class: 'eyebrow' }, project ? 'Project' : 'Overview'), h('h2', { style: { fontSize: '17px', marginTop: '4px' } }, project || 'All projects')),
          graph?.truncated && h('div', { class: 'callout warn' }, `Showing the ${limit} most important and recent memories. Raise the limit to see more.`),
          h('div', { class: 'row' }, ...Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => h('div', { class: 'stat', style: { marginRight: '14px' } }, h('b', null, fmt.int(n)), h('span', null, k === 'memory' ? 'memories' : `${k}${n === 1 ? '' : 's'}`)))),
          h('p', { class: 'dim', style: { margin: 0 } }, project ? 'Click a node to inspect it and double-click a memory to open it. Hover to follow its branch; zoom in to read memory titles.' : 'Click a project to open its areas and double-click it to explore its memories. Bigger bubbles remember more; faded ones have been quiet for three weeks. Use Areas to open them all.'),
          h('h3', null, 'Node labels'),
          h('div', { class: 'chips' }, ...labelChips()),
          h('h3', null, 'Relationship types'),
          h('div', { class: 'chips' }, ...relationshipChips()),
          h('p', { class: 'hint', style: { margin: 0 } }, project ? 'Size is importance. Click a label to highlight it. With live pulse on, a node glows when an agent reads or writes it.' : 'Bubble size is how many memories a project holds; faded ones are quiet. With live pulse on, a project glows when an agent reads or writes it.'),
        ),
      )
    }
    const d = node.data()
    const rows = [
      h('div', { class: 'row tight' }, h('span', { class: 'nlabel static', style: { background: nodeColor(d.type, d.kind), color: inkOn(nodeColor(d.type, d.kind)) } }, shapeIcon(d.type, d.kind), d.kind ?? d.type), d.status === 'superseded' && h('span', { class: 'badge auth' }, 'superseded')),
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
    rows.push(h('h3', null, 'Properties'), propertyTable(d))
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
