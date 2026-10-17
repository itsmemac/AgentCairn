import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { COMMAND_PATH, cairnCommandFile, mayWriteCommand } from '../claude.js'
import { cliCommand } from '../runner.js'

export interface InstallCommandResult {
  file: string
  written: boolean
}

/**
 * Writes the `/cairn` slash command: for every project on this machine (`~/.claude/commands`), or
 * for one project (`<dir>/.claude/commands`). A command file someone wrote by hand is never replaced.
 */
export async function installCommand(options: { scope: 'global' | 'project'; dir: string }): Promise<InstallCommandResult> {
  const base = options.scope === 'global' ? homedir() : options.dir
  const file = join(base, ...COMMAND_PATH)
  const existing = await readFile(file, 'utf8').catch(() => null)
  if (!mayWriteCommand(existing)) return { file, written: false }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, cairnCommandFile(cliCommand().command))
  return { file, written: true }
}
