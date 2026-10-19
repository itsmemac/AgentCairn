import { api } from '../api.js'
import { ago, copyText, emptyState, fmt, h, icon, initial, toast } from '../dom.js'
import { closeDrawer, openDrawer } from '../drawer.js'

const ROLE_HELP = {
  admin: 'Manages people, invitations and the server. Does not see other people’s projects unless they are shared.',
  member: 'Has a private space of their own and sees only what is shared with them.',
}
const GRANT_ROLES = ['viewer', 'editor', 'maintainer']

function inviteLink(token) {
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}#/invite/${token}`
}

export async function mount(container, { query }) {
  let { users, invites } = await api('users')
  let projects = []
  try {
    projects = (await api('projects')).projects
  } catch {
    /* the list is only for choosing what to share */
  }
  let me = null
  try {
    me = (await api('state')).userId
  } catch {
    /* not needed */
  }

  const peopleCard = h('div', { class: 'card flush' })
  const inviteCard = h('div', { class: 'card flush' })
  const linkBox = h('div')

  async function reload() {
    ;({ users, invites } = await api('users'))
    draw()
  }

  async function patch(user, body, done) {
    try {
      await api(`users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body })
      if (done) toast(done)
      await reload()
    } catch (error) {
      toast(error.message)
      await reload().catch(() => undefined)
    }
  }

  async function remove(user) {
    if (user.owned > 0) return toast(`${user.username} owns ${user.owned} project${user.owned === 1 ? '' : 's'}. Transfer or delete them first.`)
    if (!confirm(`Remove ${user.username}? Their tokens stop working and they lose access to every shared project.`)) return
    try {
      await api(`users/${encodeURIComponent(user.id)}`, { method: 'DELETE' })
      toast(`${user.username} removed`)
      await reload()
    } catch (error) {
      toast(error.message)
    }
  }

  function showLink(info, token, title) {
    const link = inviteLink(token)
    linkBox.replaceChildren(
      h(
        'div',
        { class: 'callout warn stack', style: { gap: '10px', margin: '0 18px 16px' } },
        h('b', null, title),
        h('div', { class: 'secret' }, link),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => copyText(link, 'Link copied') }, icon('copy'), 'Copy link'), h('span', { class: 'hint' }, `Works once, expires ${fmt.dateTime(info.expiresAt)}. Only a hash is stored, so it cannot be shown again.`)),
      ),
    )
  }

  async function resetLink(user) {
    try {
      const made = await api('invites', { body: { kind: 'reset', forUserId: user.id } })
      showLink(made.info, made.token, `Password reset link for ${user.username}`)
      await reload()
      linkBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } catch (error) {
      toast(error.message)
    }
  }

  function limitDrawer(user) {
    const input = h('input', { class: 'input', type: 'number', min: '0', max: '1000', placeholder: 'No limit', value: user.maxProjects ?? '', 'aria-label': 'Projects this person may own', style: { width: '160px' } })
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save')
    save.addEventListener('click', async () => {
      closeDrawer()
      await patch(user, { maxProjects: input.value === '' ? null : Number(input.value) }, 'Limit saved')
    })
    openDrawer(h('strong', null, `Limit for ${user.username}`), h('div', { class: 'stack' }, h('p', { class: 'dim' }, 'How many projects this person may own. Projects shared with them do not count. Leave it empty for no limit.'), h('div', { class: 'field' }, h('label', null, 'Projects they may own'), input), save))
    input.focus()
  }

  function userRow(u) {
    const self = u.id === me
    const roleSel = h('select', { 'aria-label': `Role of ${u.username}`, disabled: self }, ['admin', 'member'].map(r => h('option', { value: r, selected: r === u.role }, r)))
    roleSel.addEventListener('change', () => patch(u, { role: roleSel.value }, `${u.username} is now ${roleSel.value}`))
    const off = u.status === 'disabled'
    return h(
      'tr',
      { style: { opacity: off ? 0.6 : 1 } },
      h('td', null, h('div', { class: 'row tight' }, h('span', { class: 'avatar' }, initial(u.username)), h('b', null, u.username), self && h('span', { class: 'badge' }, 'you'))),
      h('td', null, roleSel),
      h('td', null, off ? h('span', { class: 'badge err' }, icon('x'), 'disabled') : h('span', { class: 'badge ok' }, icon('check'), 'active')),
      h('td', { class: 'num' }, `${u.owned}`, h('span', { class: 'sub' }, u.maxProjects === null ? 'no limit' : `of ${u.maxProjects}`)),
      h('td', { class: 'num' }, `${u.reach}`),
      h('td', null, ago(u.createdAt)),
      h(
        'td',
        { class: 'num' },
        h(
          'div',
          { class: 'row tight', style: { justifyContent: 'flex-end' } },
          h('button', { class: 'btn sm', type: 'button', onclick: () => limitDrawer(u) }, 'Limit'),
          h('button', { class: 'btn sm', type: 'button', title: 'Create a one-time link so they can choose a new password', onclick: () => resetLink(u) }, icon('key'), 'Reset link'),
          !self && h('button', { class: 'btn sm', type: 'button', onclick: () => patch(u, { status: off ? 'active' : 'disabled' }, off ? `${u.username} enabled` : `${u.username} disabled`) }, off ? 'Enable' : 'Disable'),
          !self && h('button', { class: 'btn sm danger', type: 'button', 'aria-label': `Remove ${u.username}`, onclick: () => remove(u) }, icon('trash')),
        ),
      ),
    )
  }

  function drawPeople() {
    peopleCard.replaceChildren(
      h('div', { class: 'head' }, h('div', null, h('h2', null, 'People'), h('div', { class: 'hint' }, users.length > 1 ? `${users.length} accounts. Each person has a private space; projects are shared one by one.` : 'Only you so far: Agent Cairn is in solo mode. Invite someone and projects become private to their owner.'))),
      h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Person', 'Role', 'Status', 'Owns', 'Reaches', 'Joined', ''].map(t => h('th', { class: ['Owns', 'Reaches'].includes(t) ? 'num' : undefined }, t)))), h('tbody', null, users.map(userRow)))),
    )
  }

  // ---- invite ----------------------------------------------------------------
  const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'member' }, 'member'), h('option', { value: 'admin' }, 'admin'))
  const roleHint = h('div', { class: 'hint' }, ROLE_HELP.member)
  role.addEventListener('change', () => {
    roleHint.textContent = ROLE_HELP[role.value]
    grants.hidden = role.value === 'admin'
  })
  const username = h('input', { class: 'input', placeholder: 'Let them choose', maxlength: '32', autocomplete: 'off', 'aria-label': 'Username', style: { width: '180px' } })
  const maxProjects = h('input', { class: 'input', type: 'number', min: '0', max: '1000', placeholder: 'No limit', 'aria-label': 'Project limit', style: { width: '120px' } })
  const ttl = h('select', { 'aria-label': 'Expires after' }, [1, 3, 7, 14, 30].map(d => h('option', { value: d, selected: d === 7 }, `${d} day${d === 1 ? '' : 's'}`)))
  const grantRows = []
  const grantList = h('div', { class: 'stack', style: { gap: '8px' } })
  const grants = h('div', { class: 'field' }, h('label', null, 'Share projects with them (optional)'), grantList)

  function addGrant() {
    const project = h('select', { 'aria-label': 'Project to share' }, projects.map(p => h('option', { value: p.id }, p.owner ? `${p.name} (${p.owner})` : p.name)))
    const level = h('select', { 'aria-label': 'Access level' }, GRANT_ROLES.map(r => h('option', { value: r, selected: r === 'editor' }, r)))
    const row = { project, level, el: null }
    row.el = h('div', { class: 'row tight' }, project, level, h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Remove', onclick: () => { grantRows.splice(grantRows.indexOf(row), 1); row.el.remove() } }, icon('x')))
    grantRows.push(row)
    grantList.append(row.el)
  }
  const addGrantBtn = h('button', { class: 'btn sm', type: 'button', onclick: addGrant }, icon('plus'), 'Add a project')
  const create = h('button', { class: 'btn primary', type: 'button' }, icon('plus'), 'Create invitation')

  create.addEventListener('click', async () => {
    create.disabled = true
    try {
      const body = {
        kind: 'join',
        role: role.value,
        username: username.value.trim() || undefined,
        maxProjects: maxProjects.value === '' ? null : Number(maxProjects.value),
        ttlDays: Number(ttl.value),
        grants: role.value === 'admin' ? [] : grantRows.map(g => ({ projectId: g.project.value, role: g.level.value })),
      }
      const made = await api('invites', { body })
      showLink(made.info, made.token, `Invitation ready${made.info.username ? ` for ${made.info.username}` : ''}. Send them this link.`)
      username.value = ''
      await reload()
    } catch (error) {
      toast(error.message)
    } finally {
      create.disabled = false
    }
  })

  async function revoke(inv) {
    if (!confirm('Withdraw this invitation? The link stops working immediately.')) return
    try {
      await api(`invites/${encodeURIComponent(inv.id)}`, { method: 'DELETE' })
      await reload()
    } catch (error) {
      toast(error.message)
    }
  }

  function inviteRow(inv) {
    const reset = inv.kind === 'reset'
    const what = reset ? `Password reset for ${inv.forUsername ?? 'a user'}` : `${inv.username ? inv.username : 'Anyone with the link'} as ${inv.role}`
    const pending = inv.status === 'pending'
    return h(
      'tr',
      { style: { opacity: pending ? 1 : 0.55 } },
      h('td', null, h('b', null, what), !reset && inv.grants.length > 0 && h('span', { class: 'sub' }, inv.grants.map(g => `${g.projectName}: ${g.role}`).join(', '))),
      h('td', null, inv.createdBy ?? '–', h('span', { class: 'sub' }, ago(inv.createdAt))),
      h('td', null, pending ? `expires ${fmt.dateTime(inv.expiresAt)}` : inv.status === 'used' ? `used by ${inv.usedBy ?? 'someone'}` : inv.status),
      h('td', null, h('span', { class: `badge ${pending ? 'auth' : inv.status === 'used' ? 'ok' : 'err'}` }, inv.status)),
      h('td', { class: 'num' }, pending && h('button', { class: 'btn sm danger', type: 'button', onclick: () => revoke(inv) }, icon('trash'), 'Withdraw')),
    )
  }

  function drawInvite() {
    inviteCard.replaceChildren(
      h('div', { class: 'head' }, h('div', null, h('h2', null, 'Invite someone'), h('div', { class: 'hint' }, 'They open the link, choose a password and are in. No email is sent: you pass the link on yourself.'))),
      h(
        'div',
        { style: { padding: '0 18px 18px' }, class: 'stack' },
        h('div', { class: 'row', style: { alignItems: 'flex-end', gap: '14px', flexWrap: 'wrap' } }, h('div', { class: 'field', style: { margin: 0 } }, h('label', null, 'Role'), role), h('div', { class: 'field', style: { margin: 0 } }, h('label', null, 'Username'), username), h('div', { class: 'field', style: { margin: 0 } }, h('label', null, 'May own up to'), maxProjects), h('div', { class: 'field', style: { margin: 0 } }, h('label', null, 'Link expires'), ttl)),
        roleHint,
        grants,
        h('div', { class: 'row' }, addGrantBtn, h('span', { class: 'grow' }), create),
      ),
      linkBox,
      invites.length
        ? h('div', { class: 'scroll', style: { maxHeight: '320px' } }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Invitation', 'By', 'State', '', ''].map(t => h('th', null, t)))), h('tbody', null, invites.map(inviteRow))))
        : emptyState('inbox', 'No invitations', 'Pending, used and expired invitations show up here.'),
    )
  }

  function draw() {
    drawPeople()
    // the invite form keeps its fields across redraws, so only its table is rebuilt
    drawInvite()
  }

  container.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Users'), h('div', { class: 'sub' }, 'Invite people, set what they may own, and disable or remove them. Sharing a project is done on the project itself.'))),
    h('div', { class: 'stack', style: { gap: '16px' } }, peopleCard, inviteCard),
  )
  draw()
  if (query?.invite !== undefined) username.focus()
}
