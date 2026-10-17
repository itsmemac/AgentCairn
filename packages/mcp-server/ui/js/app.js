import { api, onUnauthorized } from './api.js'
import { clear, h, icon, initial, startClock, svg } from './dom.js'
import { closeDrawer } from './drawer.js'
import { live } from './store.js'
import { mountLogin, mountSetup } from './views/auth.js'

const root = document.getElementById('root')

// ---- theme -----------------------------------------------------------------

const THEME_KEY = 'aib-theme'
const savedTheme = () => {
  try {
    return localStorage.getItem(THEME_KEY)
  } catch {
    return null
  }
}
const applyTheme = theme => {
  if (theme) document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}
applyTheme(savedTheme())
const isDark = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches

// ---- routes ----------------------------------------------------------------

const ROUTES = [
  { pattern: /^\/live$/, nav: 'live', load: () => import('./views/live.js') },
  { pattern: /^\/projects$/, nav: 'projects', load: () => import('./views/projects.js') },
  { pattern: /^\/projects\/([^/]+)$/, nav: 'projects', params: ['id'], load: () => import('./views/project.js') },
  { pattern: /^\/graph$/, nav: 'graph', load: () => import('./views/graph.js') },
  { pattern: /^\/query$/, nav: 'query', load: () => import('./views/query.js') },
  { pattern: /^\/access$/, nav: 'access', load: () => import('./views/access.js') },
  { pattern: /^\/system$/, nav: 'system', load: () => import('./views/system.js') },
]

const NAV = [
  ['Monitor', [['live', 'Live', 'live']]],
  ['Explore', [['projects', 'Projects', 'folder'], ['graph', 'Graph', 'graph'], ['query', 'Query', 'terminal']]],
  ['Manage', [['access', 'Access', 'key'], ['system', 'System', 'server']]],
]
const TITLES = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([key, label]) => [key, label])))

export function navigate(hash) {
  location.hash = hash
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/live'
  const [path, search = ''] = raw.split('?')
  return { path, query: Object.fromEntries(new URLSearchParams(search)) }
}

function logo() {
  return svg(
    'svg',
    { viewBox: '0 0 32 32', 'aria-hidden': 'true' },
    svg('ellipse', { cx: 16, cy: 23.5, rx: 9, ry: 3.8, fill: 'var(--text)' }),
    svg('ellipse', { cx: 16, cy: 16.2, rx: 6.4, ry: 3.2, fill: 'var(--text)' }),
    svg('ellipse', { class: 'pulse', cx: 16, cy: 9.6, rx: 3.8, ry: 2.8, fill: 'var(--s1)' }),
  )
}

// ---- app shell -------------------------------------------------------------

let cleanup = null
let shell = null

function mountShell(username, version) {
  clear(root)
  const brand = h('div', { class: 'brand' }, logo(), 'Agent Cairn', version && h('small', null, `v${version}`))
  const links = NAV.flatMap(([group, items]) => [
    h('div', { class: 'label' }, group),
    ...items.map(([key, label, ic]) => {
      const count = h('span', { class: 'count', dataset: { count: key } })
      return h('a', { class: 'item', href: `#/${key}`, dataset: { nav: key }, title: label }, icon(ic), h('span', { class: 't' }, label), count)
    }),
  ])
  const dot = h('span', { class: 'dot' })
  const connText = h('span', { class: 'conn-text' }, 'connecting')
  const themeBtn = h('button', { class: 'btn sm ghost', type: 'button', title: 'Toggle light and dark', 'aria-label': 'Toggle theme' })
  const syncThemeBtn = () => themeBtn.replaceChildren(icon(isDark() ? 'sun' : 'moon'))
  themeBtn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark'
    applyTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* private mode */
    }
    syncThemeBtn()
  })
  syncThemeBtn()

  const logout = h('button', { class: 'btn sm ghost', type: 'button', title: 'Sign out', 'aria-label': 'Sign out' }, icon('logout'))
  logout.addEventListener('click', async () => {
    await api('logout', { body: {} }).catch(() => undefined)
    boot()
  })

  const outlet = h('main', { class: 'main', id: 'outlet' })
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Main' },
    brand,
    ...links,
    h('div', { class: 'spacer' }),
    h('div', { class: 'foot' }, h('div', { class: 'conn' }, dot, connText), h('div', { class: 'row tight' }, h('div', { class: 'me grow' }, h('span', { class: 'avatar' }, initial(username)), h('span', { class: 'name dim' }, username)), themeBtn, logout)),
  )
  root.append(h('div', { class: 'app' }, nav, outlet))

  const sync = kind => {
    if (kind === 'status') {
      dot.className = `dot ${live.status === 'live' ? 'live' : live.status === 'down' ? 'down' : ''}`
      connText.textContent = live.status === 'live' ? 'live stream' : live.status === 'down' ? 'disconnected' : 'connecting'
    }
    if (kind === 'stats' && live.stats) {
      const active = live.stats.clients.filter(c => c.active).length
      const el = nav.querySelector('[data-count="live"]')
      if (el) el.textContent = active ? `${active} online` : ''
    }
    if (kind === 'event') {
      brand.classList.remove('beat')
      void brand.offsetWidth
      brand.classList.add('beat')
    }
  }
  const unsubscribe = live.subscribe(sync)
  sync('status')
  shell = { outlet, nav, unsubscribe }
}

async function route() {
  if (!shell) return
  cleanup?.()
  cleanup = null
  closeDrawer()
  const { path, query } = parseHash()
  const match = ROUTES.map(r => [r, r.pattern.exec(path)]).find(([, m]) => m)
  const [def, m] = match ?? [ROUTES[0], null]
  const params = Object.fromEntries((def.params ?? []).map((name, i) => [name, decodeURIComponent(m?.[i + 1] ?? '')]))

  document.title = `${TITLES[def.nav] ?? 'Dashboard'} · Agent Cairn`
  for (const a of shell.nav.querySelectorAll('a.item')) {
    if (a.dataset.nav === def.nav) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  clear(shell.outlet)
  window.scrollTo(0, 0)
  try {
    const view = await def.load()
    const result = await view.mount(shell.outlet, { params, query, navigate })
    if (typeof result === 'function') cleanup = result
  } catch (error) {
    console.error(error)
    shell.outlet.append(h('div', { class: 'card' }, h('h2', null, 'Something went wrong'), h('p', { class: 'error' }, String(error?.message ?? error))))
  }
}

window.addEventListener('hashchange', route)

// ---- boot ------------------------------------------------------------------

async function boot() {
  cleanup?.()
  cleanup = null
  shell?.unsubscribe()
  shell = null
  live.stop()
  let state
  try {
    state = await api('state')
  } catch (error) {
    clear(root).append(h('div', { class: 'auth-page' }, h('div', { class: 'card panel' }, h('h1', null, 'Cannot reach the server'), h('p', { class: 'lead' }, error.message), h('button', { class: 'btn primary', onclick: boot }, 'Retry'))))
    return
  }
  if (state.setupRequired) return mountSetup(root, boot)
  if (!state.authenticated) return mountLogin(root, boot)
  mountShell(state.username, state.version)
  live.start()
  route()
}

onUnauthorized(() => boot())
startClock()
boot()
