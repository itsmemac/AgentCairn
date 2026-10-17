import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * How hooks should invoke this CLI. Installed from npm, `npx` fetches it.
 * From a source checkout, the built file's path is used (machine-specific:
 * `cairn init --local` keeps it out of shared settings).
 */
export function cliCommand(env: NodeJS.ProcessEnv = process.env): { command: string; isMachineSpecific: boolean } {
  if (env.CAIRN_CLI) return { command: env.CAIRN_CLI, isMachineSpecific: false }
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url))
  if (bin.includes(`${sep}node_modules${sep}`)) return { command: 'npx -y agentcairn', isMachineSpecific: false }
  return { command: `node "${bin.replace(/\\/g, '/')}"`, isMachineSpecific: true }
}
