import { api } from '../api.js'
import { clear, h, svg } from '../dom.js'

function brand() {
  return h(
    'div',
    { class: 'brand' },
    svg(
      'svg',
      { viewBox: '0 0 32 32', 'aria-hidden': 'true' },
      svg('g', { stroke: 'var(--s1)', 'stroke-width': 2, 'stroke-linecap': 'round' }, svg('path', { d: 'M9 21 16 10M16 10l8 11M9 21h15' })),
      svg('circle', { cx: 9, cy: 21, r: 3, fill: 'var(--text)' }),
      svg('circle', { cx: 16, cy: 10, r: 3.4, fill: 'var(--s1)' }),
      svg('circle', { cx: 24, cy: 21, r: 3, fill: 'var(--text)' }),
    ),
    'Agent Cairn',
  )
}

function field(label, input, hint) {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`
  input.id = id
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint && h('span', { class: 'hint' }, hint))
}

function page(...children) {
  return h('div', { class: 'auth-page' }, h('div', { class: 'card panel' }, brand(), ...children))
}

async function submit(form, button, errorEl, work) {
  errorEl.textContent = ''
  button.disabled = true
  try {
    await work()
  } catch (error) {
    errorEl.textContent = error.message
    button.disabled = false
  }
}

export function mountSetup(root, done) {
  const error = h('p', { class: 'error', role: 'alert' })
  const code = h('input', { class: 'input mono', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX', maxlength: '14', required: true })
  code.addEventListener('input', () => {
    const raw = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
    code.value = raw.replace(/(.{4})(?=.)/g, '$1-')
  })
  const username = h('input', { class: 'input', autocomplete: 'username', required: true, minlength: '3', maxlength: '32', value: 'admin' })
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: '10' })
  const confirm = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true })
  const button = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', justifyContent: 'center' } }, 'Create admin account')
  const form = h(
    'form',
    null,
    field('One-time setup code', code, 'Printed in the server log when it started.'),
    field('Admin username', username),
    field('Password', password, 'At least 10 characters.'),
    field('Repeat password', confirm),
    error,
    button,
  )
  form.addEventListener('submit', e => {
    e.preventDefault()
    submit(form, button, error, async () => {
      if (password.value !== confirm.value) throw new Error('The passwords do not match.')
      await api('setup', { body: { code: code.value, username: username.value, password: password.value } })
      done()
    })
  })
  clear(root).append(
    page(
      h('h1', null, 'Set up Agent Cairn'),
      h('p', { class: 'lead' }, 'Create the admin account for this dashboard.'),
      h(
        'div',
        { class: 'callout', style: { marginBottom: '16px' } },
        'The one-time setup code is printed in the server log when it starts. With Docker: ',
        h('code', null, 'docker logs <container>'),
        ' (or open the container’s Logs in your Docker UI).',
      ),
      form,
    ),
  )
  code.focus()
}

export function mountLogin(root, done) {
  const error = h('p', { class: 'error', role: 'alert' })
  const username = h('input', { class: 'input', autocomplete: 'username', required: true })
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true })
  const button = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', justifyContent: 'center' } }, 'Sign in')
  const form = h('form', null, field('Username', username), field('Password', password), error, button)
  form.addEventListener('submit', e => {
    e.preventDefault()
    submit(form, button, error, async () => {
      await api('login', { body: { username: username.value, password: password.value } })
      done()
    })
  })
  clear(root).append(page(h('h1', null, 'Sign in'), h('p', { class: 'lead' }, 'The looking glass for your project memory.'), form))
  username.focus()
}
