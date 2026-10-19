import { api, qs } from '../api.js'
import { emptyState, fmt, h, toast } from '../dom.js'

const GROUPS = [
  ['', 'Everything'],
  ['login', 'Sign-ins'],
  ['user.', 'Accounts'],
  ['invite.', 'Invitations'],
  ['member.', 'Sharing'],
  ['project.', 'Projects'],
  ['token.', 'Tokens'],
  ['console.', 'Query console'],
]
const PAGE = 100

export async function mount(container) {
  let events = []
  let prefix = ''
  let more = false

  const body = h('tbody')
  const table = h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['When', 'Who', 'What', 'On', 'Detail'].map(t => h('th', null, t)))), body))
  const holder = h('div', { class: 'card flush' })
  const select = h('select', { 'aria-label': 'Kind of event' }, GROUPS.map(([v, label]) => h('option', { value: v }, label)))
  const moreBtn = h('button', { class: 'btn', type: 'button' }, 'Load older')

  function rows(list) {
    return list.map(e =>
      h(
        'tr',
        null,
        h('td', { title: e.at }, h('span', { class: 'mono', style: { fontSize: '12px' } }, fmt.dateTime(e.at))),
        h('td', null, e.actor ?? h('span', { class: 'muted' }, 'system')),
        h('td', null, h('span', { class: `badge ${/failed|removed|disabled|revoked|deleted/.test(e.action) ? 'err' : /created|accepted|added|enabled/.test(e.action) ? 'ok' : ''}` }, e.action)),
        h('td', null, e.target ?? ''),
        h('td', { class: 'dim' }, e.detail ?? ''),
      ),
    )
  }

  async function load(append) {
    moreBtn.disabled = true
    try {
      const { events: got } = await api(`audit?${qs({ limit: PAGE, action: prefix, before: append ? events[events.length - 1]?.at : undefined })}`)
      events = append ? [...events, ...got] : got
      more = got.length === PAGE
      draw(append ? got : events, append)
    } catch (error) {
      toast(error.message)
    } finally {
      moreBtn.disabled = false
    }
  }

  function draw(list, append) {
    if (!events.length) {
      holder.replaceChildren(emptyState('inbox', 'Nothing recorded', prefix ? 'No events of this kind.' : 'Sign-ins and changes to accounts, sharing, tokens and projects show up here.'))
      return
    }
    if (!holder.contains(table)) holder.replaceChildren(table, h('div', { class: 'row', style: { padding: '12px 18px', justifyContent: 'center' } }, moreBtn))
    if (append) body.append(...rows(list))
    else body.replaceChildren(...rows(list))
    moreBtn.hidden = !more
  }

  select.addEventListener('change', () => {
    prefix = select.value
    load(false)
  })
  moreBtn.addEventListener('click', () => load(true))

  container.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Audit log'), h('div', { class: 'sub' }, 'Who changed what, kept for 180 days. Secrets and memory content are never recorded.')), h('div', { class: 'row' }, select)),
    holder,
  )
  await load(false)
}
