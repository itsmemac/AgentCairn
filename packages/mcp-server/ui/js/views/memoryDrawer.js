import { api, qs } from '../api.js'
import { copyText, fmt, h, icon, kindLabel } from '../dom.js'
import { openDrawer } from '../drawer.js'

export const importance = n => h('span', { class: 'mono', title: `importance ${n} of 5`, 'aria-label': `importance ${n} of 5` }, '●'.repeat(n) + '○'.repeat(5 - n))

/** Opens one memory with its provenance and its supersede history. */
export function openMemory(project, id, navigate) {
  const title = h('div', { class: 'row' }, h('h2', null, 'Memory'), h('span', { class: 'mono muted' }, `#${id.slice(0, 8)}`))
  const drawer = openDrawer(title, h('div', { class: 'muted' }, 'Loading…'))

  api(`memories/${encodeURIComponent(id)}?${qs({ project })}`)
    .then(({ memory: m, chain }) => {
      const link = item =>
        h('a', { href: '#', onclick: e => { e.preventDefault(); openMemory(project, item.id, navigate) } }, h('span', { class: 'mono' }, `#${item.id.slice(0, 8)}`), ` ${item.title}`, h('span', { class: 'muted' }, ` · ${fmt.ago(item.createdAt)}`))
      const chainBlock = (heading, items) =>
        items.length && h('div', { class: 'stack', style: { gap: '4px' } }, h('h3', null, heading), ...items.map(i => h('div', null, link(i))))
      drawer.body.replaceChildren(
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'row' }, kindLabel(m.kind), m.status === 'superseded' && h('span', { class: 'badge auth' }, 'superseded'), m.area && h('span', { class: 'tag' }, m.area), importance(m.importance)),
          h('h1', { style: { fontSize: '19px' } }, m.title),
          h('pre', { class: 'pre' }, m.body),
          m.paths.length > 0 && h('div', null, h('h3', null, 'Paths'), h('div', { class: 'tags', style: { marginTop: '6px' } }, m.paths.map(p => h('span', { class: 'tag' }, p)))),
          chainBlock('Replaced by (newer)', chain.replacedBy),
          chainBlock('Replaced (older)', chain.replaced),
          h('dl', { class: 'kv' },
            ...[['Written', fmt.dateTime(m.createdAt)], ['Written by', m.writtenBy ? `${m.writtenBy}${m.viaToken ? ` (token ${m.viaToken})` : ''}` : 'unknown (written before this was recorded)'], ['Author (git, self-reported)', m.author ?? '–'], ['Agent', m.agent ?? '–'], ['Machine', m.machine ?? '–'], ['Commit', m.commitSha ? h('span', { class: 'mono' }, m.commitSha.slice(0, 12)) : '–'], ['Review by', m.reviewBy ? (m.reviewBy <= new Date().toISOString().slice(0, 10) ? `${m.reviewBy} (due)` : m.reviewBy) : '–'], ['Revisit when', m.revisitWhen ?? '–'], ['Full id', h('span', { class: 'mono' }, m.id)]].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => { drawer.close(); navigate(`#/graph?project=${encodeURIComponent(project)}&focus=${m.id.slice(0, 8)}`) } }, icon('graph'), 'Show in graph'),
            h('button', { class: 'btn', type: 'button', onclick: () => copyText(`#${m.id.slice(0, 8)}`) }, icon('copy'), 'Copy short id')),
        ),
      )
    })
    .catch(error => drawer.body.replaceChildren(h('p', { class: 'error' }, error.message)))
}
