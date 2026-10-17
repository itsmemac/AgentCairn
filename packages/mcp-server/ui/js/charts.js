import { fmt, h, svg } from './dom.js'

// ---- tooltip (one shared element) -----------------------------------------

let tip
export function showTip(event, title, rows) {
  tip ??= document.body.appendChild(h('div', { class: 'tooltip', role: 'tooltip' }))
  tip.replaceChildren(
    h('b', null, title),
    ...rows.map(([label, value]) => h('div', { class: 'r' }, h('span', null, label), h('strong', null, value))),
  )
  tip.style.display = 'block'
  const pad = 14
  const w = tip.offsetWidth
  const x = event.clientX + pad + w > window.innerWidth ? event.clientX - w - pad : event.clientX + pad
  tip.style.left = `${Math.max(4, x)}px`
  tip.style.top = `${Math.min(window.innerHeight - tip.offsetHeight - 4, event.clientY + pad)}px`
}
export function hideTip() {
  if (tip) tip.style.display = 'none'
}

function niceMax(v) {
  if (v <= 4) return 4
  const pow = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 5, 10]) if (m * pow >= v) return m * pow
  return v
}

/** Column whose data end (top) is rounded and whose baseline end is square. */
function columnPath(x, y, w, hgt, r) {
  const rr = Math.min(r, w / 2, hgt)
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`
}

// ---- requests per minute ---------------------------------------------------

/**
 * Stacked columns, one per minute for the last hour: successful requests in the
 * accent, failures stacked above in the status color. Hover any column for the numbers.
 */
export function createThroughput() {
  const holder = h('div', { class: 'chart' })
  let data = []
  const M = { l: 36, r: 6, t: 8, b: 22 }
  const H = 168

  function draw() {
    const W = Math.max(320, holder.clientWidth || 640)
    const iw = W - M.l - M.r
    const ih = H - M.t - M.b
    const max = niceMax(Math.max(1, ...data.map(d => d.requests)))
    const step = iw / Math.max(1, data.length)
    const barW = Math.max(2, Math.min(24, step - 2))
    const y = v => M.t + ih - (v / max) * ih

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Requests per minute, last hour' })
    for (const f of [0, 0.5, 1]) {
      const yy = y(max * f)
      root.append(svg('line', { class: f === 0 ? 'axis' : 'grid', x1: M.l, x2: W - M.r, y1: yy, y2: yy }))
      root.append(svg('text', { x: M.l - 6, y: yy + 4, 'text-anchor': 'end' }, fmt.num(max * f)))
    }
    data.forEach((d, i) => {
      const x = M.l + i * step + (step - barW) / 2
      const ok = d.requests - d.errors
      const okH = (ok / max) * ih
      const errH = (d.errors / max) * ih
      if (ok > 0) root.append(svg('path', { d: columnPath(x, y(ok), barW, Math.max(okH, 2), d.errors ? 0.01 : 3), fill: 'var(--s1)' }))
      if (d.errors > 0) root.append(svg('path', { d: columnPath(x, y(ok) - errH - (ok ? 2 : 0), barW, Math.max(errH, 2), 3), fill: 'var(--crit)' }))
      const hit = svg('rect', { class: 'hit', x: M.l + i * step, y: M.t, width: step, height: ih, tabindex: '-1' })
      hit.addEventListener('pointermove', e =>
        showTip(e, fmt.clock(d.t), [
          ['Requests', fmt.int(d.requests)],
          ['Errors', fmt.int(d.errors)],
          ['Tokens out', fmt.int(d.tokensOut)],
        ]),
      )
      hit.addEventListener('pointerleave', hideTip)
      root.append(hit)
    })
    for (const i of [0, 15, 30, 45]) {
      root.append(svg('text', { x: M.l + i * step + step / 2, y: H - 6, 'text-anchor': 'middle' }, i === 0 ? '60m ago' : `${60 - i}m`))
    }
    root.append(svg('text', { x: W - M.r - step / 2, y: H - 6, 'text-anchor': 'end' }, 'now'))
    holder.replaceChildren(root)
  }

  new ResizeObserver(() => data.length && draw()).observe(holder)
  return {
    el: holder,
    update(perMinute) {
      data = perMinute
      draw()
    },
  }
}

/** The same data as a table, for anyone who prefers numbers (and for assistive tech). */
export function throughputTable(perMinute) {
  const rows = perMinute.filter(d => d.requests > 0).reverse()
  if (!rows.length) return h('div', { class: 'empty' }, 'No requests in the last hour.')
  return h(
    'div',
    { class: 'scroll', style: { maxHeight: '170px' } },
    h(
      'table',
      { class: 'tbl' },
      h('thead', null, h('tr', null, ['Minute', 'Requests', 'Errors', 'Tokens out'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h(
        'tbody',
        null,
        rows.map(d =>
          h('tr', null, h('td', { class: 'mono' }, fmt.clock(d.t)), h('td', { class: 'num' }, fmt.int(d.requests)), h('td', { class: 'num' }, fmt.int(d.errors)), h('td', { class: 'num' }, fmt.int(d.tokensOut))),
        ),
      ),
    ),
  )
}

// ---- sparkline -------------------------------------------------------------

export function sparkline(values, { w = 92, h: height = 30 } = {}) {
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? (w - 8) / (values.length - 1) : 0
  const pts = values.map((v, i) => [4 + i * step, height - 5 - (v / max) * (height - 10)])
  const root = svg('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height, 'aria-hidden': 'true', class: 'spark' })
  if (pts.length > 1) {
    root.append(svg('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: 'var(--s1)', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
  }
  const last = pts.at(-1)
  if (last) root.append(svg('circle', { cx: last[0], cy: last[1], r: 4, fill: 'var(--s1)', stroke: 'var(--surface)', 'stroke-width': 2 }))
  return root
}
