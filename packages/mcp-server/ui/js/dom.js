// Tiny DOM helpers: no framework, no innerHTML for data (only for the static icon set below).

const SVG_NS = 'http://www.w3.org/2000/svg'

// Views write `cond && element` freely; append/prepend/replaceChildren would turn a false into the text "false".
for (const name of ['append', 'prepend', 'replaceChildren']) {
  const original = Element.prototype[name]
  Element.prototype[name] = function (...nodes) {
    return original.apply(this, nodes.flat(Infinity).filter(n => n !== false && n !== null && n !== undefined))
  }
}

function apply(el, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value)
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'value' || key === 'checked' || key === 'selected' || key === 'disabled') el[key] = value
    else el.setAttribute(key, value === true ? '' : String(value))
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  apply(el, props)
  append(el, children)
  return el
}

export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag)
  apply(el, props)
  append(el, children)
  return el
}

export function clear(el) {
  el.replaceChildren()
  return el
}

const ICONS = {
  live: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7l8 1M7 8l4 8M17 10l-4 6"/>',
  terminal: '<path d="M4 5h16v14H4z"/><path d="M8 10l3 2-3 2M13 15h4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 14-5l2-2v6h-6l2.2-2.2A5.5 5.5 0 0 0 6.5 12M20 12a8 8 0 0 1-14 5l-2 2v-6h6l-2.2 2.2A5.5 5.5 0 0 0 17.5 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  zap: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  inbox: '<path d="M4 13l3-8h10l3 8v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
  zoomin: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4M11 8v6M8 11h6"/>',
  zoomout: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4M8 11h6"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
}

export function icon(name) {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('viewBox', '0 0 24 24')
  el.setAttribute('width', '16')
  el.setAttribute('height', '16')
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('stroke-width', '2')
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML = ICONS[name] ?? '' // static strings above, never data
  return el
}

// ---- formatting -----------------------------------------------------------

export const fmt = {
  num(n) {
    if (n === null || n === undefined) return '–'
    const a = Math.abs(n)
    if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
    if (a >= 1e4) return `${(n / 1e3).toFixed(0)}K`
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`
    return String(Math.round(n))
  },
  int(n) {
    return n === null || n === undefined ? '–' : Math.round(n).toLocaleString('en-US')
  },
  bytes(n) {
    if (!n) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`
  },
  ms(n) {
    if (n === null || n === undefined) return '–'
    return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`
  },
  ago(iso) {
    if (!iso) return 'never'
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
    if (s < 5) return 'just now'
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  },
  clock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour12: false })
  },
  dateTime(iso) {
    return iso ? new Date(iso).toLocaleString([], { hour12: false }) : '–'
  },
  uptime(seconds) {
    const d = Math.floor(seconds / 86400)
    const hh = Math.floor((seconds % 86400) / 3600)
    const mm = Math.floor((seconds % 3600) / 60)
    return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m ${seconds % 60}s`
  },
}

/** A <time> that keeps counting ("12s ago") without re-rendering its view. */
export function ago(iso) {
  return h('time', { dataset: { ts: iso ?? '' }, title: iso ? fmt.dateTime(iso) : '' }, fmt.ago(iso))
}

export function startClock() {
  setInterval(() => {
    for (const el of document.querySelectorAll('time[data-ts]')) {
      if (el.dataset.ts) el.textContent = fmt.ago(el.dataset.ts)
    }
  }, 1000)
}

// ---- small UI helpers ------------------------------------------------------

export function toast(message) {
  const el = h('div', { class: 'toast', role: 'status' }, icon('check'), message)
  document.getElementById('toasts')?.append(el)
  setTimeout(() => el.remove(), 2400)
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = h('textarea', { style: { position: 'fixed', opacity: '0' } })
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  toast(label)
}

/** A code block with a copy button. */
export function codeBox(text) {
  return h(
    'div',
    { class: 'code-box' },
    h('pre', { class: 'pre' }, text),
    h('button', { class: 'btn sm copy', type: 'button', onclick: () => copyText(text) }, icon('copy'), 'Copy'),
  )
}

/** A friendly "nothing here" block: an icon, a headline, a line of help and an optional action. */
export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'glyph' }, icon(iconName)), h('b', null, title), text && h('div', null, text), action)
}

/** A search field with a magnifier inside it. */
export function searchBox(props) {
  const input = h('input', { class: 'input', type: 'search', ...props })
  return { el: h('div', { class: 'search' }, icon('search'), input), input }
}

export const initial = name => (name?.trim()?.[0] ?? '?').toUpperCase()

export function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

export const KINDS = ['handoff', 'overview', 'decision', 'convention', 'gotcha', 'checkpoint', 'thread', 'glossary']

/**
 * Renders the small Markdown a handoff is written in (`## headings`, `- bullets`, `1. steps`) as elements.
 * Text only goes in through textContent, never as HTML.
 */
export function renderNotes(body) {
  const out = []
  let list = null
  const flush = () => {
    if (list) out.push(list)
    list = null
  }
  for (const raw of String(body).split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const heading = /^##\s+(.*)$/.exec(line)
    const bullet = /^-\s+(.*)$/.exec(line)
    const step = /^\d+\.\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      out.push(h('h4', { class: 'notes-h' }, heading[1]))
    } else if (bullet || step) {
      const tag = step ? 'ol' : 'ul'
      if (!list || list.tagName.toLowerCase() !== tag) {
        flush()
        list = h(tag, { class: 'notes-list' })
      }
      list.append(h('li', null, (bullet ?? step)[1]))
    } else {
      flush()
      out.push(h('p', { class: 'notes-p' }, line))
    }
  }
  flush()
  return h('div', { class: 'notes' }, ...out)
}

export function kindLabel(kind) {
  return h('span', { class: `kind k-${kind}` }, kind)
}

/** One-line horizontal stacked bar of memory counts by kind. */
export function kindBar(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!total) return h('div', { class: 'stackbar' })
  return h(
    'div',
    { class: 'stackbar', role: 'img', 'aria-label': KINDS.filter(k => counts[k]).map(k => `${counts[k]} ${k}`).join(', ') },
    KINDS.filter(k => counts[k]).map(k =>
      h('span', { class: `k-${k}`, style: { flex: String(counts[k]) }, title: `${counts[k]} ${k}` }),
    ),
  )
}

export function kindLegend(kinds = KINDS) {
  return h(
    'div',
    { class: 'legend' },
    kinds.map(k => h('span', null, h('i', { class: `sw k-${k}`, style: { background: 'var(--k)' } }), k)),
  )
}

/** A compact status glyph for dense tables: shape and title carry the meaning, not just colour. */
export function statusMark(event) {
  const [cls, name, label] = event.source === 'auth' ? ['auth', 'lock', 'denied'] : event.ok ? ['ok', 'check', 'ok'] : ['err', 'x', 'error']
  return h('span', { class: `st ${cls}`, title: `${label} (HTTP ${event.httpStatus})`, role: 'img', 'aria-label': label }, icon(name))
}

export function statusBadge(event) {
  if (event.source === 'auth') return h('span', { class: 'badge auth' }, icon('lock'), 'denied')
  return event.ok ? h('span', { class: 'badge ok' }, icon('check'), String(event.httpStatus)) : h('span', { class: 'badge err' }, icon('x'), String(event.httpStatus))
}
