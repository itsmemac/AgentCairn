import { api } from '../api.js'
import { fmt, h, icon, toast } from '../dom.js'

const kv = rows => h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))

function counts(obj) {
  const entries = Object.entries(obj)
  const max = Math.max(1, ...entries.map(([, n]) => n))
  return h('table', { class: 'tbl' }, h('tbody', null, entries.map(([name, n]) => h('tr', null, h('td', { class: 'mono' }, name), h('td', null, h('span', { class: 'bar', style: { width: `${Math.max(2, (n / max) * 120)}px` } })), h('td', { class: 'num' }, fmt.int(n))))))
}

export async function mount(container) {
  const body = h('div', { class: 'stack' })
  const refreshBtn = h('button', { class: 'btn', type: 'button' }, icon('refresh'), 'Refresh')

  async function load() {
    const s = await api('system')
    body.replaceChildren(
      h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('div', { class: 'head' }, h('h2', null, 'Server')), kv([
          ['Version', s.server.version], ['Node', s.server.node], ['Platform', s.server.platform], ['Process id', String(s.server.pid)],
          ['Uptime', fmt.uptime(s.server.uptimeSeconds)], ['Memory', `${s.server.rssMb} MB resident · ${s.server.heapMb} MB heap`],
        ])),
        h('div', { class: 'card' }, h('div', { class: 'head' }, h('h2', null, 'Neo4j')), kv([
          ['Server', s.neo4j.agent], ['Address', h('span', { class: 'mono' }, s.neo4j.address)], ['Configured URI', h('span', { class: 'mono' }, s.neo4j.uri)], ['User', s.neo4j.user],
          ['Round trip', fmt.ms(s.neo4j.pingMs)], ['Schema version', String(s.neo4j.schemaVersion ?? 'unknown')],
          ['Credentials', s.neo4j.defaultCredentials ? h('span', { class: 'badge auth' }, icon('alert'), 'default password: change it') : h('span', { class: 'badge ok' }, icon('check'), 'customized')],
        ])),
      ),
      h('div', { class: 'grid2' },
        h('div', { class: 'card flush' }, h('div', { class: 'head' }, h('h2', null, 'Nodes in the graph')), counts(s.graph.labels)),
        h('div', { class: 'card flush' }, h('div', { class: 'head' }, h('h2', null, 'Relationships')), counts(s.graph.relationships)),
      ),
      h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('div', { class: 'head' }, h('h2', null, 'Security & capture')), kv([
          ['Dashboard tokens', `${s.auth.managedTokens} active`],
          ['Static token (CAIRN_TOKEN)', s.auth.envToken ? h('span', { class: 'badge ok' }, icon('check'), 'set') : h('span', { class: 'muted' }, 'not set')],
          ['Authentication', s.auth.noAuth ? h('span', { class: 'badge err' }, icon('alert'), 'DISABLED (CAIRN_NO_AUTH)') : h('span', { class: 'badge ok' }, icon('lock'), 'required')],
          ['Payload capture', s.capture.mode === 'full' ? 'full: requests and responses are kept in memory' : 'summary only'],
          ['Event buffer', `last ${fmt.int(s.capture.capacity)} requests, in memory only (cleared on restart)`],
        ]), h('p', { class: 'hint', style: { marginBottom: 0 } }, 'Authorization headers are never recorded. Set CAIRN_CAPTURE=meta to stop keeping payloads.')),
        passwordCard(),
      ),
    )
  }

  function passwordCard() {
    const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' })
    const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: '10' })
    const error = h('p', { class: 'error', role: 'alert' })
    const save = h('button', { class: 'btn', type: 'submit' }, 'Change password')
    const form = h('form', null, h('div', { class: 'field' }, h('label', null, 'Current password'), current), h('div', { class: 'field' }, h('label', null, 'New password (10+ characters)'), next), error, save)
    form.addEventListener('submit', async e => {
      e.preventDefault()
      error.textContent = ''
      save.disabled = true
      try {
        await api('password', { body: { current: current.value, next: next.value } })
        current.value = next.value = ''
        toast('Password changed. Other sessions were signed out.')
      } catch (err) {
        error.textContent = err.message
      } finally {
        save.disabled = false
      }
    })
    return h('div', { class: 'card' }, h('div', { class: 'head' }, h('h2', null, 'Admin password')), form)
  }

  refreshBtn.addEventListener('click', () => load().catch(e => toast(e.message)))
  container.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'System'), h('div', { class: 'sub' }, 'The server, its database, and how it is protected.')), refreshBtn), body)
  await load()
}
