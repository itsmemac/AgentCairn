export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message)
    this.status = status
    this.code = code
    this.body = body
  }
}

const unauthorizedListeners = new Set()
export const onUnauthorized = fn => unauthorizedListeners.add(fn)

export async function api(path, { method, body } = {}) {
  let res
  try {
    res = await fetch(`/admin/api/${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && data.error === 'login_required') for (const fn of unauthorizedListeners) fn()
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status}).`, data)
  }
  return data
}

export const qs = params =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
