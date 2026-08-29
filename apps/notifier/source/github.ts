import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import type { ReferenceKind, ReferenceResolver, Repository } from '@webhook-noti/core'
import type { Dispatcher } from 'undici'

/* oxlint-disable crackle/pascal-case */

interface CachedClient {
  Client: Octokit
  ExpiresAt: number
}

export interface WorkflowJob {
  Id: number
  Name: string
  Status: string
  Conclusion: string | null
}

function Expired(ExpiresAt: number): boolean {
  return ExpiresAt <= Date.now() + 60_000
}

function GithubParameters(RepositoryValue: Repository): { owner: string, repo: string } {
  return { owner: RepositoryValue.Owner, repo: RepositoryValue.Name }
}

export class GithubClient {
  private readonly AppAuth: ReturnType<typeof createAppAuth>
  private AppClient: CachedClient | undefined
  private readonly InstallationIds = new Map<string, number>()
  private readonly InstallationClients = new Map<string, CachedClient>()

  constructor(AppId: string, PrivateKey: string, private readonly ProxyDispatcher?: Dispatcher) {
    this.AppAuth = createAppAuth({ appId: AppId, privateKey: PrivateKey })
  }

  private CreateClient(Token: string): Octokit {
    return new Octokit({
      auth: Token,
      ...(this.ProxyDispatcher === undefined ? {} : {
        request: {
          // undici's fetch accepts a non-standard `dispatcher` init option; the lowercase name is its actual API contract.
          // oxlint-disable-next-line crackle/pascal-case
          fetch: async (Url: string | URL | Request, Init?: RequestInit) => fetch(Url, { ...Init, dispatcher: this.ProxyDispatcher } as RequestInit & { dispatcher: Dispatcher })
        }
      })
    })
  }

  private async GetAppClient(): Promise<Octokit> {
    if (this.AppClient !== undefined && !Expired(this.AppClient.ExpiresAt)) return this.AppClient.Client
    const Authentication = await this.AppAuth({ type: 'app' })
    this.AppClient = { Client: this.CreateClient(Authentication.token), ExpiresAt: Date.parse(Authentication.expiresAt) }
    return this.AppClient.Client
  }

  private async InstallationId(RepositoryValue: Repository): Promise<number> {
    const Slug = `${RepositoryValue.Owner}/${RepositoryValue.Name}`
    const Cached = this.InstallationIds.get(Slug)
    if (Cached !== undefined) return Cached
    const Response = await (await this.GetAppClient()).request('GET /repos/{owner}/{repo}/installation', GithubParameters(RepositoryValue))
    const Installation = Response.data as { id?: unknown }
    if (typeof Installation.id !== 'number') throw new Error(`GitHub App is not installed for ${Slug}`)
    this.InstallationIds.set(Slug, Installation.id)
    return Installation.id
  }

  private async ClientFor(RepositoryValue: Repository): Promise<Octokit> {
    const Slug = `${RepositoryValue.Owner}/${RepositoryValue.Name}`
    const Cached = this.InstallationClients.get(Slug)
    if (Cached !== undefined && !Expired(Cached.ExpiresAt)) return Cached.Client
    const Authentication = await this.AppAuth({ type: 'installation', installationId: await this.InstallationId(RepositoryValue) })
    const Client = { Client: this.CreateClient(Authentication.token), ExpiresAt: Date.parse(Authentication.expiresAt) }
    this.InstallationClients.set(Slug, Client)
    return Client.Client
  }

  async ResolveReference(Reference: Parameters<ReferenceResolver>[0]): Promise<ReferenceKind> {
    const Response = await (await this.ClientFor(Reference.Repository)).request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner: Reference.Repository.Owner,
      repo: Reference.Repository.Name,
      issue_number: Reference.Number
    })
    const Issue = Response.data as { pull_request?: unknown }
    return Issue.pull_request === undefined ? 'issue' : 'pull'
  }

  async ResolveCommit(RepositoryValue: Repository, Reference: string): Promise<string> {
    const Response = await (await this.ClientFor(RepositoryValue)).request('GET /repos/{owner}/{repo}/commits/{ref}', { ...GithubParameters(RepositoryValue), ref: Reference })
    const Commit = Response.data as { sha?: unknown }
    if (typeof Commit.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(Commit.sha)) throw new Error(`GitHub did not return an immutable commit SHA for ${Reference}`)
    return Commit.sha
  }

  async PackageJson(RepositoryValue: Repository, CommitSha: string): Promise<string> {
    const Response = await (await this.ClientFor(RepositoryValue)).request('GET /repos/{owner}/{repo}/contents/{path}', { ...GithubParameters(RepositoryValue), path: 'package.json', ref: CommitSha })
    const Content = Response.data as { content?: unknown, encoding?: unknown }
    if (Content.encoding !== 'base64' || typeof Content.content !== 'string') throw new Error(`package.json is not a base64 file at ${CommitSha}`)
    return Buffer.from(Content.content.replaceAll('\n', ''), 'base64').toString('utf8')
  }

  async PurgeJobs(RepositoryValue: Repository, CommitSha: string): Promise<WorkflowJob[]> {
    const Client = await this.ClientFor(RepositoryValue)
    const RunsResponse = await Client.request('GET /repos/{owner}/{repo}/actions/runs', { ...GithubParameters(RepositoryValue), event: 'release', head_sha: CommitSha, per_page: 100 })
    const Runs = (RunsResponse.data as { workflow_runs?: unknown }).workflow_runs
    if (!Array.isArray(Runs)) throw new Error(`GitHub did not return workflow runs for ${CommitSha}`)
    const Jobs = await Promise.all(Runs.map(async (Run) => {
      if (typeof Run !== 'object' || Run === null || typeof (Run as { id?: unknown }).id !== 'number') return []
      const Response = await Client.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', { ...GithubParameters(RepositoryValue), run_id: (Run as { id: number }).id, per_page: 100 })
      const RunJobs = (Response.data as { jobs?: unknown }).jobs
      if (!Array.isArray(RunJobs)) return []
      return RunJobs.flatMap((Job): WorkflowJob[] => {
        if (typeof Job !== 'object' || Job === null) return []
        const Value = Job as { id?: unknown, name?: unknown, status?: unknown, conclusion?: unknown }
        if (Value.name !== 'Purge jsdelivr cache' || typeof Value.id !== 'number' || typeof Value.status !== 'string' || (typeof Value.conclusion !== 'string' && Value.conclusion !== null)) return []
        return [{ Id: Value.id, Name: Value.name, Status: Value.status, Conclusion: Value.conclusion }]
      })
    }))
    return Jobs.flat()
  }

  async RerunJob(RepositoryValue: Repository, JobId: number): Promise<void> {
    await (await this.ClientFor(RepositoryValue)).request('POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun', { ...GithubParameters(RepositoryValue), job_id: JobId })
  }
}

/* oxlint-enable crackle/pascal-case */
