import { api } from '../api.js'
import { ago, codeBox, copyText, emptyState, h, icon, toast } from '../dom.js'

export async function mount(container, { query }) {
  const [{ projects }, tokensReply] = await Promise.all([api('projects'), api('tokens')])
  let tokens = tokensReply.tokens
  let fresh = null // the token just created, kept only in this page's memory
  let method = 'claude'

  const tokenCard = h('div', { class: 'card flush' })
  const connectCard = h('div', { class: 'card' })
  const secretBox = h('div')

  // ---- tokens --------------------------------------------------------------
  const nameInput = h('input', { class: 'input', placeholder: 'Name, e.g. laptop or ci-runner', maxlength: '60', 'aria-label': 'Token name', style: { width: '250px' } })
  const createBtn = h('button', { class: 'btn primary', type: 'button' }, icon('plus'), 'Create token')

  async function create() {
    createBtn.disabled = true
    try {
      const made = await api('tokens', { body: { name: nameInput.value } })
      fresh = made.token
      nameInput.value = ''
      tokens = (await api('tokens')).tokens
      secretBox.replaceChildren(
        h(
          'div',
          { class: 'callout warn stack', style: { gap: '10px', margin: '0 18px 16px' } },
          h('b', null, `Token "${made.info.name}" created. Copy it now: it is shown only once.`),
          h('div', { class: 'secret' }, made.token),
          h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => copyText(made.token, 'Token copied') }, icon('copy'), 'Copy token'), h('span', { class: 'hint' }, 'Only a hash is stored on the server.')),
        ),
      )
      drawTokens()
      drawConnect()
    } catch (error) {
      toast(error.message)
    } finally {
      createBtn.disabled = false
    }
  }
  createBtn.addEventListener('click', create)
  nameInput.addEventListener('keydown', e => e.key === 'Enter' && create())

  async function revoke(t) {
    if (!confirm(`Revoke "${t.name}"? Anything using it stops working immediately.`)) return
    try {
      await api(`tokens/${t.id}`, { method: 'DELETE' })
      tokens = (await api('tokens')).tokens
      drawTokens()
    } catch (error) {
      toast(error.message)
    }
  }

  function drawTokens() {
    const active = tokens.filter(t => !t.revokedAt)
    tokenCard.replaceChildren(
      h('div', { class: 'head' }, h('div', null, h('h2', null, 'Access tokens'), h('div', { class: 'hint' }, `${active.length} active · agents and the cairn CLI send one as a bearer token`)), h('div', { class: 'tools' }, nameInput, createBtn)),
      secretBox,
      tokens.length
        ? h('div', { class: 'scroll', style: { maxHeight: '340px' } }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Name', 'Token', 'Created', 'Last used', 'Status', ''].map(t => h('th', null, t)))),
            h('tbody', null, tokens.map(t => h('tr', { style: { opacity: t.revokedAt ? 0.55 : 1 } },
              h('td', null, h('span', { class: 'tool-name' }, t.name)),
              h('td', { class: 'mono' }, `${t.prefix}…`),
              h('td', null, ago(t.createdAt), t.createdBy && h('span', { class: 'sub' }, `by ${t.createdBy}`)),
              h('td', null, t.lastUsedAt ? ago(t.lastUsedAt) : h('span', { class: 'muted' }, 'never')),
              h('td', null, t.revokedAt ? h('span', { class: 'badge err' }, icon('x'), 'revoked') : h('span', { class: 'badge ok' }, icon('check'), 'active')),
              h('td', { class: 'num' }, !t.revokedAt && h('button', { class: 'btn sm danger', type: 'button', onclick: () => revoke(t) }, icon('trash'), 'Revoke')),
            )))))
        : emptyState('key', 'No tokens yet', 'Create one, then connect an agent below.'),
      tokens.length > 0 && active.length === 0 && h('div', { class: 'hint', style: { padding: '0 18px 16px' } }, 'All tokens are revoked: agents cannot connect until you create a new one.'),
    )
  }

  // ---- connect -------------------------------------------------------------
  const origin = h('input', { class: 'input mono', value: location.origin, 'aria-label': 'Server address', style: { width: '280px' } })
  const projectSelect = h('select', { 'aria-label': 'Project' }, projects.map(p => h('option', { value: p.id }, p.name)), h('option', { value: '' }, 'A project name or id…'))
  const customProject = h('input', { class: 'input', placeholder: 'project-id', 'aria-label': 'Project id', style: { display: 'none', width: '160px' } })
  if (query.project) projectSelect.value = query.project
  else if (!projects.length) projectSelect.value = ''
  projectSelect.addEventListener('change', () => {
    customProject.style.display = projectSelect.value === '' ? '' : 'none'
    drawConnect()
  })
  for (const el of [origin, customProject]) el.addEventListener('input', drawConnect)

  const METHODS = [
    ['claude', 'Claude Code', 'One command, once per machine. It works in every folder: the project comes from .cairn.json or the git remote. Needs Node 20+.'],
    ['http', 'Direct HTTP', 'No Node needed. Run it inside the project folder; the project header tells the server which brain to use.'],
    ['mcp', '.mcp.json', 'Commit this with the repo. Each person sets CAIRN_URL and CAIRN_TOKEN in their environment, so no secret is committed.'],
    ['cli', 'cairn CLI', 'Also installs the Claude Code hooks (briefing at session start, checkpoint reminder) and a CLAUDE.md block.'],
    ['check', 'Check it', 'Two requests: the server is up and can reach Neo4j, and your token and project are accepted.'],
  ]

  function drawConnect() {
    const base = origin.value.replace(/\/+$/, '')
    const project = projectSelect.value || customProject.value.trim() || 'my-project'
    const token = fresh ?? '<your-token>'
    const known = projects.some(p => p.id === project)
    const snippets = {
      claude: `claude mcp add cairn --scope user -e CAIRN_URL=${base} -e CAIRN_TOKEN=${token} -- npx -y agentcairn mcp`,
      http: `claude mcp add --transport http cairn ${base}/mcp --header "Authorization: Bearer ${token}" --header "X-Cairn-Project: ${project}"`,
      mcp: JSON.stringify({ mcpServers: { 'cairn': { type: 'http', url: '${CAIRN_URL}/mcp', headers: { Authorization: 'Bearer ${CAIRN_TOKEN}', 'X-Cairn-Project': project } } } }, null, 2),
      cli: `export CAIRN_URL=${base}\nexport CAIRN_TOKEN=${token}\nbrain init ${project}`,
      check: `curl ${base}/healthz\ncurl -H "Authorization: Bearer ${token}" -H "X-Cairn-Project: ${project}" ${base}/api/project`,
    }
    const [, , blurb] = METHODS.find(([k]) => k === method)
    const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Connection method' }, ...METHODS.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(k === method), onclick: () => { method = k; drawConnect() } }, label)))
    connectCard.replaceChildren(
      h('div', { class: 'head' }, h('div', null, h('h2', null, 'Connect an agent'), h('div', { class: 'hint' }, 'Pick a project, then copy the snippet for your tool.')), tabs),
      h('div', { class: 'row', style: { marginBottom: '14px', alignItems: 'flex-end', gap: '14px' } },
        h('div', { class: 'field', style: { margin: 0 } }, h('label', null, 'Server address, as your computers see it'), origin),
        h('div', { class: 'field', style: { margin: 0 } }, h('label', null, 'Project'), h('div', { class: 'row tight' }, projectSelect, customProject)),
      ),
      !known && h('div', { class: 'callout warn', style: { marginBottom: '12px' } }, `"${project}" does not exist yet. Create it under Projects → New project before an agent writes its first memory.`),
      !fresh && h('div', { class: 'hint', style: { marginBottom: '10px' } }, 'Create a token above and it is filled in here automatically. Tokens are never shown again, so these snippets use a placeholder until then.'),
      codeBox(snippets[method]),
      h('p', { class: 'hint', style: { margin: '10px 0 0' } }, blurb),
    )
  }

  container.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Access'), h('div', { class: 'sub' }, 'Who can talk to this server, and how to connect an agent in under a minute.'))),
    h('div', { class: 'stack', style: { gap: '16px' } }, tokenCard, connectCard),
  )
  drawTokens()
  drawConnect()
}
