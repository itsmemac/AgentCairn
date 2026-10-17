import { api } from '../api.js'
import { copyText, fmt, h, icon, statusBadge, codeBox } from '../dom.js'
import { openDrawer } from '../drawer.js'
import { jsonView } from '../json.js'

const label = e => e.tool ?? e.method

/** Opens the full record of one request: what came in, what went back, and which memories it touched. */
export function openEvent(summary, navigate) {
  const body = h('div', null, h('div', { class: 'muted' }, 'Loading…'))
  const title = h('div', { class: 'row', style: { minWidth: 0 } }, h('h2', { class: 'mono' }, label(summary)), statusBadge(summary))
  const drawer = openDrawer(title, body)

  api(`events/${summary.id}`)
    .then(event => drawer.body.replaceChildren(render(event, navigate, drawer.close)))
    .catch(error => drawer.body.replaceChildren(h('p', { class: 'error' }, error.message)))
}

function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))
}

function render(event, navigate, close) {
  const tabs = ['Overview', 'Request', 'Response', 'Raw']
  const panels = {
    Overview: overview(event, navigate, close),
    Request: panel(event.request, 'No request payload was captured (capture mode is "meta" or the request had no body).'),
    Response: responsePanel(event),
    Raw: codeBox(JSON.stringify(event, null, 2)),
  }
  const content = h('div')
  const bar = h('div', { class: 'tabs', role: 'tablist' })
  const show = name => {
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.textContent === name))
    content.replaceChildren(panels[name])
  }
  for (const name of tabs) bar.append(h('button', { type: 'button', role: 'tab', onclick: () => show(name) }, name))
  show(event.tool || event.request ? 'Overview' : 'Overview')
  return h('div', null, bar, content)
}

function panel(value, empty) {
  if (value === undefined) return h('div', { class: 'muted' }, empty)
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(JSON.stringify(value, null, 2)) }, icon('copy'), 'Copy JSON')), jsonView(value))
}

function responsePanel(event) {
  const r = event.response
  if (r === undefined) return h('div', { class: 'muted' }, 'No response payload was captured.')
  if (typeof r?.text === 'string') {
    return h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row' }, h('span', { class: 'muted' }, `${fmt.int(event.tokensOut)} tokens (est.) sent to the agent`), h('span', { class: 'grow' }), h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(r.text) }, icon('copy'), 'Copy text')),
      h('pre', { class: 'pre' }, r.text),
    )
  }
  return panel(r, '')
}

function overview(event, navigate, close) {
  const client = event.client
  const refs = event.memoryRefs.length
    ? h(
        'span',
        { class: 'tags' },
        event.memoryRefs.map(ref =>
          h(
            'span',
            {
              class: 'tag ref',
              role: 'link',
              tabindex: '0',
              title: 'Show in the graph',
              onclick: () => {
                close()
                navigate(`#/graph?project=${encodeURIComponent(event.project ?? '')}&focus=${ref}`)
              },
            },
            `#${ref}`,
          ),
        ),
      )
    : h('span', { class: 'muted' }, 'none')
  return h(
    'div',
    { class: 'stack' },
    event.error && h('div', { class: 'callout warn' }, event.error),
    kv([
      ['Time', fmt.dateTime(event.ts)],
      ['Source', event.source === 'mcp' ? 'MCP (agent)' : event.source === 'api' ? 'JSON API (CLI / hooks)' : 'Rejected request'],
      ['Call', h('span', { class: 'mono' }, event.tool ? `${event.method} → ${event.tool}` : event.method)],
      ['Project', event.project ?? h('span', { class: 'muted' }, 'not specified')],
      ['Token', client.token ?? h('span', { class: 'muted' }, 'none')],
      ['Agent', client.agent ?? '–'],
      ['IP address', client.ip ?? '–'],
      ['User-Agent', client.userAgent ? h('span', { class: 'mono' }, client.userAgent) : '–'],
      ['Duration', fmt.ms(event.durationMs)],
      ['HTTP status', String(event.httpStatus)],
      ['Request size', fmt.bytes(event.bytesIn)],
      ['Response size', fmt.bytes(event.bytesOut)],
      ['Tokens out (est.)', fmt.int(event.tokensOut)],
      ['Memories touched', refs],
    ]),
  )
}
