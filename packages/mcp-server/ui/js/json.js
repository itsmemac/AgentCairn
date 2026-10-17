import { h } from './dom.js'

const LONG = 240

function leaf(value) {
  if (value === null) return h('span', { class: 'z' }, 'null')
  if (typeof value === 'number') return h('span', { class: 'n' }, String(value))
  if (typeof value === 'boolean') return h('span', { class: 'b' }, String(value))
  if (typeof value === 'string') {
    if (value.length <= LONG) return h('span', { class: 's' }, JSON.stringify(value))
    const holder = h('span', { class: 's' }, `${JSON.stringify(value.slice(0, LONG))}… `)
    holder.append(
      h('span', { class: 'more', role: 'button', tabindex: '0', onclick: () => holder.replaceChildren(JSON.stringify(value)) }, `(+${value.length - LONG} more characters)`),
    )
    return holder
  }
  return h('span', null, String(value))
}

function node(key, value, depth) {
  const label = key === null ? [] : [h('span', { class: 'k' }, JSON.stringify(key)), ': ']
  if (value === null || typeof value !== 'object') return h('div', null, label, leaf(value))

  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value)
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
  if (entries.length === 0) return h('div', null, label, h('span', { class: 'z' }, `${open}${close}`))

  const summary = h('summary', null, label, open, h('span', { class: 'z' }, ` ${entries.length} ${Array.isArray(value) ? 'items' : 'keys'} `), '…', close)
  const body = h('div', { class: 'ind' }, entries.map(([k, v]) => node(Array.isArray(value) ? null : k, v, depth + 1)))
  return h('div', null, h('details', { open: depth < 2 }, summary, body, h('div', null, close)))
}

/** A collapsible, copyable view of any JSON value. */
export function jsonView(value) {
  if (value === undefined) return h('div', { class: 'muted' }, 'Not captured.')
  return h('div', { class: 'json' }, node(null, value, 0))
}
