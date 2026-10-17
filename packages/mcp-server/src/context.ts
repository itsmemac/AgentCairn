import { hostname } from 'node:os'
import {
  type Brain,
  type ProjectHint,
  type ResolvedProject,
  RemoteConflictError,
  attachRemote,
  ensureProject,
  ensureSchema,
  getRepoState,
  resolveProject,
  resolveProjectFromHint,
} from '@agentcairn/core'

/**
 * Where the project comes from. A local (stdio) server reads the folder the
 * agent works in; a remote server cannot, so the client says who it is.
 */
export type Scope = { cwd: string } | { hint: ProjectHint }

export interface Provenance {
  commitSha?: string
  author?: string
  agent?: string
  machine?: string
}

const SHA = /^[0-9a-f]{7,40}$/i

/** Everything a tool call needs: the brain, which project, and who is asking. */
export class BrainContext {
  private schema: Promise<void> | undefined

  constructor(
    readonly brain: Brain,
    readonly scope: Scope,
    private readonly clientName: () => string | undefined = () => undefined,
    /** Told which project each call resolved to (the dashboard shows it). */
    private readonly onProject: (projectId: string) => void = () => undefined,
  ) {}

  /** The folder, when the server can see one (stdio mode). */
  get cwd(): string | undefined {
    return 'cwd' in this.scope ? this.scope.cwd : undefined
  }

  /** Creates the schema once; a failed attempt is retried on the next call. */
  ready(): Promise<void> {
    this.schema ??= ensureSchema(this.brain).catch(error => {
      this.schema = undefined
      throw error
    })
    return this.schema
  }

  /**
   * Identifies the project. Writes also create a project that was only known
   * by its git remote (an explicit id is never auto-created here: `cairn init`
   * does that on purpose).
   */
  async project(options: { write: boolean }): Promise<ResolvedProject> {
    await this.ready()
    const project =
      'cwd' in this.scope
        ? await resolveProject(this.brain, this.scope.cwd)
        : await resolveProjectFromHint(this.brain, this.scope.hint)

    this.onProject(project.projectId)
    if (options.write && project.isNew && project.source === 'remote') {
      await ensureProject(this.brain, project.projectId)
      if (project.remoteHash) {
        try {
          await attachRemote(this.brain, project.projectId, project.remoteHash)
        } catch (error) {
          if (!(error instanceof RemoteConflictError)) throw error
        }
      }
      return { ...project, isNew: false }
    }
    return project
  }

  /**
   * Who wrote a memory. Locally the server reads git itself; remotely the
   * client's hook supplies the commit and author. Values that do not look like
   * a commit are ignored, so an agent guessing cannot corrupt staleness.
   */
  async provenance(given: { commitSha?: string; author?: string } = {}): Promise<Provenance> {
    const given_ = {
      commitSha: given.commitSha && SHA.test(given.commitSha) ? given.commitSha : undefined,
      author: given.author?.trim().slice(0, 100) || undefined,
    }
    if (this.cwd) {
      const repo = await getRepoState(this.cwd)
      return {
        commitSha: given_.commitSha ?? repo.head ?? undefined,
        author: given_.author ?? repo.user ?? undefined,
        agent: this.clientName(),
        machine: hostname(),
      }
    }
    return { ...given_, agent: this.clientName() }
  }
}
