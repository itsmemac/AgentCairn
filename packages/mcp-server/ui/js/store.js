import { api } from './api.js'

/**
 * The live connection to the server: recent events, rolling stats, and a
 * server-sent stream that keeps both current. Views subscribe and re-draw.
 */
const MAX_EVENTS = 500

export const live = {
  status: 'idle', // idle | connecting | live | down
  stats: null,
  events: [],
  listeners: new Set(),
  source: null,

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },

  emit(kind, payload) {
    for (const fn of this.listeners) {
      try {
        fn(kind, payload)
      } catch (error) {
        console.error('live listener failed', error)
      }
    }
  },

  async start() {
    if (this.source) return
    this.status = 'connecting'
    this.emit('status')
    await this.backfill()
    const source = new EventSource('/admin/api/stream')
    this.source = source
    source.addEventListener('open', () => {
      this.status = 'live'
      this.emit('status')
    })
    source.addEventListener('error', () => {
      this.status = source.readyState === EventSource.CLOSED ? 'down' : 'connecting'
      this.emit('status')
    })
    source.addEventListener('stats', e => {
      this.stats = JSON.parse(e.data)
      this.emit('stats', this.stats)
    })
    source.addEventListener('event', e => {
      const event = JSON.parse(e.data)
      if (this.events.some(x => x.id === event.id)) return
      this.events.unshift(event)
      if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS
      this.emit('event', event)
    })
  },

  async backfill() {
    try {
      const { events } = await api('events?limit=300')
      const known = new Set(this.events.map(e => e.id))
      this.events = [...this.events, ...events.filter(e => !known.has(e.id))].sort((a, b) => b.id - a.id).slice(0, MAX_EVENTS)
    } catch {
      // the stream will still deliver new events
    }
  },

  stop() {
    this.source?.close()
    this.source = null
    this.status = 'idle'
    this.stats = null
    this.events = []
    this.emit('status')
  },
}
