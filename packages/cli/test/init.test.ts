import { describe, expect, it } from 'vitest'
import { nextSteps } from '../src/commands/init.js'

describe('what init tells you to do next', () => {
  it('only asks to restart when the server is registered or the variables are set', () => {
    for (const state of [
      { registered: true, wroteMcpJson: false, envSet: false },
      { registered: true, wroteMcpJson: true, envSet: false },
      { registered: false, wroteMcpJson: true, envSet: true },
    ]) {
      const text = nextSteps(state).join('\n')
      expect(text, JSON.stringify(state)).toContain('restart Claude Code')
      expect(text, JSON.stringify(state)).not.toContain('not set')
    }
  })

  it('asks for the variables only when .mcp.json needs them and they are missing', () => {
    const text = nextSteps({ registered: false, wroteMcpJson: true, envSet: false }).join('\n')
    expect(text).toContain('CAIRN_URL and CAIRN_TOKEN')
    expect(text).toContain('not set')
  })
})
