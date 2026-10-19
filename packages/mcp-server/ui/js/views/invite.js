import { api } from '../api.js'
import { clear, h } from '../dom.js'
import { brand, field, page, submit } from './auth.js'

/** The page behind an invitation link: public, so it asks the server what the link is before showing a form. */
export async function mountInvite(root, token, done) {
  clear(root).append(page(h('p', { class: 'lead' }, 'Checking your invitation…')))
  let info
  try {
    info = await api(`invite/${encodeURIComponent(token)}`)
  } catch (error) {
    return clear(root).append(
      page(
        h('h1', null, 'This link no longer works'),
        h('p', { class: 'lead' }, error.status === 404 || error.status === 410 ? 'It was already used, withdrawn or has expired. Ask the person who invited you for a new one.' : error.message),
        h('a', { class: 'btn', href: '#/' }, 'Go to sign in'),
      ),
    )
  }

  const reset = info.kind === 'reset'
  const fixed = reset ? info.forUsername : info.username
  const error = h('p', { class: 'error', role: 'alert' })
  const username = h('input', { class: 'input', autocomplete: 'username', required: true, minlength: '3', maxlength: '32', value: fixed ?? '', disabled: Boolean(fixed) })
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: '10' })
  const confirmField = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true })
  const button = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', justifyContent: 'center' } }, reset ? 'Set password' : 'Create account')
  const form = h('form', null, field('Username', username, fixed ? undefined : 'Letters, numbers, dot, dash and underscore.'), field('Password', password, 'At least 10 characters.'), field('Repeat password', confirmField), error, button)
  form.addEventListener('submit', e => {
    e.preventDefault()
    submit(form, button, error, async () => {
      if (password.value !== confirmField.value) throw new Error('The passwords do not match.')
      await api(`invite/${encodeURIComponent(token)}/accept`, { body: { username: fixed ? undefined : username.value, password: password.value } })
      history.replaceState(null, '', '#/projects') // leaves the single-use link out of the address bar and history
      done()
    })
  })

  clear(root).append(
    page(
      h('h1', null, reset ? 'Choose a new password' : 'Join Agent Cairn'),
      h('p', { class: 'lead' }, reset ? `For ${info.forUsername}.` : info.invitedBy ? `${info.invitedBy} invited you as ${info.role === 'admin' ? 'an admin' : 'a member'}.` : `You were invited as ${info.role === 'admin' ? 'an admin' : 'a member'}.`),
      !reset && info.grants.length > 0 && h('div', { class: 'callout', style: { marginBottom: '16px' } }, 'You will start with access to: ', info.grants.map((g, i) => [i > 0 && ', ', h('b', null, g.projectName), ` (${g.role})`])),
      form,
    ),
  )
  ;(fixed ? password : username).focus()
}

export { brand }
