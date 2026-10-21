import { svg } from './dom.js'

/** The Agent Cairn mark: a stack of stones with a blue one on top. It follows the theme through var(--text). */
export function logo() {
  return svg(
    'svg',
    { viewBox: '25 33 140 140', 'aria-hidden': 'true' },
    svg('ellipse', { cx: 95, cy: 140, rx: 56, ry: 22, fill: 'var(--text)' }),
    svg('ellipse', { cx: 95, cy: 106, rx: 40, ry: 17, fill: 'var(--text)', opacity: 0.82 }),
    svg('ellipse', { cx: 95, cy: 78, rx: 27, ry: 14, fill: 'var(--text)', opacity: 0.64 }),
    svg('ellipse', { class: 'pulse', cx: 95, cy: 55, rx: 15, ry: 11, fill: 'var(--s1)' }),
  )
}
