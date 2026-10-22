import { hostname } from 'node:os'
import {
  AccessError,
  PENDING,
  ProjectNotFoundError,
  type Action,
  type Brain,
  type Principal,
  type ProjectHint,
  type ResolvedProject,
  ProjectNameError,
  RemoteConflictError,
  SOLO_PRINCIPAL,
  attachRemote,
  authorize,
  createProject,
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
  /** Stamped from the authenticated request: the user and the token name, which the client cannot choose. */
  writtenBy?: string
  viaToken?: string
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
    /** Who is asking. Every project use is checked against this. */
    readonly principal: Principal = SOLO_PRINCIPAL,
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
  async project(options: { write: boolean; action?: Action }): Promise<ResolvedProject> {
    await this.ready()
    const project =
      'cwd' in this.scope
        ? await resolveProject(this.brain, this.scope.cwd)
        : await resolveProjectFromHint(this.brain, this.scope.hint, this.principal)

    this.onProject(project.projectId)
    if (!project.isNew) {
      await authorize(this.brain, this.principal, options.action ?? (options.write ? 'memory.write' : 'memory.read'), project.projectId)
      return project
    }
    if (options.write && project.source === 'remote') {
      const created = await this.createFromRemote(project)
      this.onProject(created.projectId)
      return created
    }
    // an explicit id or name is never created implicitly, and a project you cannot see reads as missing
    if (options.write) throw new ProjectNotFoundError(project.requested ?? project.projectId.replace(PENDING, ''))
    return project
  }

  /** First write from a repository nobody has a project for yet: a project owned by the caller, named after the repository. */
  private async createFromRemote(project: ResolvedProject): Promise<ResolvedProject> {
    let id = project.projectId
    if (this.principal.scope && (this.principal.scope.projects || this.principal.scope.readOnly)) {
      throw new AccessError('forbidden', project.suggestedName ?? 'project', 'project.update', 'scope')
    }
    if (this.principal.userId === SOLO_PRINCIPAL.userId) {
      // before any account exists there is nobody to own it: the plain legacy form
      id = `git-${project.remoteHash}`
      await ensureProject(this.brain, id)
    } else {
      const base = project.suggestedName ?? 'project'
      for (let n = 1; ; n++) {
        try {
          id = (await createProject(this.brain, this.principal.userId, n === 1 ? base : `${base} (${n})`)).id
          break
        } catch (error) {
          if (!(error instanceof ProjectNameError && error.code === 'exists') || n >= 20) throw error
        }
      }
    }
    if (project.remoteHash) {
      try {
        await attachRemote(this.brain, id, project.remoteHash, { principal: this.principal })
      } catch (error) {
        if (!(error instanceof RemoteConflictError)) throw error
      }
    }
    return { ...project, projectId: id, isNew: false }
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
    const identity = {
      writtenBy: this.principal.userId === SOLO_PRINCIPAL.userId ? undefined : this.principal.username,
      viaToken: this.principal.tokenName,
    }
    if (this.cwd) {
      const repo = await getRepoState(this.cwd)
      return {
        ...identity,
        commitSha: given_.commitSha ?? repo.head ?? undefined,
        author: given_.author ?? repo.user ?? undefined,
        agent: this.clientName(),
        machine: hostname(),
      }
    }
    return { ...given_, ...identity, agent: this.clientName() }
  }
}
