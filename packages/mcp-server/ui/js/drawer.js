import { h, icon } from './dom.js'

let current = null

/** Closes whatever drawer is open (the router calls this on every page change). */
export function closeDrawer() {
  current?.close()
}

/** A right-hand panel over a dimmed page. Escape or a click outside closes it. */
export function openDrawer(title, body) {
  current?.close()
  const previous = document.activeElement
  const backdrop = h('div', { class: 'backdrop' })
  const closeBtn = h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Close' }, icon('x'))
  const drawer = h(
    'aside',
    { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Details' },
    h('header', null, h('div', { class: 'row grow', style: { minWidth: 0 } }, title), closeBtn),
    h('div', { class: 'body' }, body),
  )
  const onKey = e => {
    if (e.key === 'Escape') close()
  }
  function close() {
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
    drawer.remove()
    if (current?.close === close) current = null
    previous?.focus?.()
  }
  backdrop.addEventListener('click', close)
  closeBtn.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  document.body.append(backdrop, drawer)
  closeBtn.focus()
  current = { close }
  return { close, body: drawer.querySelector('.body') }
}
