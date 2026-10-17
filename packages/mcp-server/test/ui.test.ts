import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The dashboard has no build step, so a typo in an import path would only show up in a browser.
const uiDir = resolve(import.meta.dirname, '../ui')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

describe('dashboard UI files', () => {
  const scripts = walk(join(uiDir, 'js')).filter(f => f.endsWith('.js'))

  it('has a page, a stylesheet, an icon and the views', () => {
    for (const f of ['index.html', 'css/app.css', 'favicon.svg', 'js/app.js']) expect(existsSync(join(uiDir, f)), f).toBe(true)
    expect(scripts.length).toBeGreaterThan(10)
  })

  it('every relative import resolves to a file', () => {
    const missing: string[] = []
    for (const file of scripts) {
      const source = readFileSync(file, 'utf8')
      const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map(m => m[1]!)
      for (const spec of specifiers) if (!existsSync(resolve(dirname(file), spec))) missing.push(`${file} -> ${spec}`)
    }
    expect(missing).toEqual([])
  })

  it('every name imported from a local module is exported by it', () => {
    const problems: string[] = []
    for (const file of scripts) {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), m[2]!)
        if (!existsSync(target)) continue
        const exported = readFileSync(target, 'utf8')
        for (const raw of m[1]!.split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0]!.trim()
          if (name && !new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(exported)) {
            problems.push(`${file} imports ${name} from ${m[2]}`)
          }
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('the page is CSP-clean: no inline scripts or handlers, only same-origin assets', () => {
    const html = readFileSync(join(uiDir, 'index.html'), 'utf8')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    for (const url of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]!)) {
      expect(url.startsWith('/ui/') || url.startsWith('#'), url).toBe(true)
      if (url.startsWith('/ui/')) expect(existsSync(join(uiDir, url.slice(4))), url).toBe(true)
    }
  })

  it('views build their DOM safely: no innerHTML outside the static icon set', () => {
    const offenders = scripts.filter(f => !f.endsWith('dom.js') && /\.innerHTML\s*=|insertAdjacentHTML/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
