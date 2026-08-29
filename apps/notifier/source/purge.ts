import type { Release } from '@webhook-noti/core'
import type { Dispatcher } from 'undici'
import type { GithubClient } from './github.js'

const PurgeJobName = 'Purge jsdelivr cache'
const PollIntervalMs = 5_000
const PollTimeoutMs = 10 * 60_000
const GlobalpingApiUrl = 'https://api.globalping.io/v1/measurements'

export function SubscriptionUrlFromPackageJson(PackageJson: string): URL | null {
  const Scripts = (JSON.parse(PackageJson) as Record<string, unknown>)['scripts']
  if (typeof Scripts !== 'object' || Scripts === null || Array.isArray(Scripts)) return null
  for (const Script of Object.values(Scripts)) {
    if (typeof Script !== 'string') continue
    const Match = /(?:^|\s)--SubscriptionUrl(?:=|\s+)(\S+)/.exec(Script)
    if (Match?.[1] === undefined) continue
    const Url = new URL(Match[1].replace(/^['"]|['"]$/g, ''))
    if (Url.protocol !== 'https:') throw new Error('--SubscriptionUrl must use HTTPS')
    return Url
  }
  return null
}

async function GlobalpingResponse(Response: Response): Promise<unknown> {
  if (!Response.ok) throw new Error(`Globalping API returned HTTP ${Response.status}`)
  return Response.json()
}

/* oxlint-disable crackle/pascal-case */

function MeasurementId(Value: unknown): string {
  if (typeof Value !== 'object' || Value === null || typeof (Value as { id?: unknown }).id !== 'string') {
    throw new Error('Globalping API did not return a measurement ID')
  }
  return (Value as { id: string }).id
}

function HasSuccessfulProbe(Value: unknown): boolean {
  if (typeof Value !== 'object' || Value === null || !Array.isArray((Value as { results?: unknown }).results)) return false
  return (Value as { results: unknown[] }).results.some((Result) => {
    if (typeof Result !== 'object' || Result === null) return false
    const HttpResult = (Result as { result?: unknown }).result
    if (typeof HttpResult !== 'object' || HttpResult === null || typeof (HttpResult as { statusCode?: unknown }).statusCode !== 'number') return false
    const StatusCode = (HttpResult as { statusCode: number }).statusCode
    return StatusCode >= 200 && StatusCode < 300
  })
}

function MeasurementFinished(Value: unknown): boolean {
  if (typeof Value !== 'object' || Value === null || typeof (Value as { status?: unknown }).status !== 'string') return false
  const Status = (Value as { status: string }).status.toLowerCase()
  return Status === 'finished' || Status === 'completed'
}

export async function ConfirmCdn(Url: URL, ApiToken: string, ProxyDispatcher?: Dispatcher, Fetch: typeof fetch = fetch): Promise<void> {
  const RequestPath = `${Url.pathname}${Url.search}`
  const DispatcherOptions = ProxyDispatcher === undefined ? {} : {
    // undici's fetch accepts a non-standard `dispatcher` init option; the lowercase name is its actual API contract.
    // oxlint-disable-next-line crackle/pascal-case
    dispatcher: ProxyDispatcher
  }
  const CreateResponse = await Fetch(GlobalpingApiUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${ApiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'http',
      target: Url.hostname,
      locations: [{ magic: 'World' }],
      measurementOptions: { protocol: 'HTTPS', request: { method: 'HEAD', path: RequestPath } }
    }),
    ...DispatcherOptions
  })
  const Id = MeasurementId(await GlobalpingResponse(CreateResponse))
  const Deadline = Date.now() + PollTimeoutMs
  while (Date.now() < Deadline) {
    const MeasurementResponse = await Fetch(`${GlobalpingApiUrl}/${Id}`, { headers: { authorization: `Bearer ${ApiToken}` }, ...DispatcherOptions })
    const Measurement = await GlobalpingResponse(MeasurementResponse)
    if (HasSuccessfulProbe(Measurement)) return
    if (MeasurementFinished(Measurement)) throw new Error('Globalping measurement completed without a successful HTTP response')
    await Wait(PollIntervalMs)
  }
  throw new Error(`Timed out waiting for Globalping measurement ${Id}`)
}

/* oxlint-enable crackle/pascal-case */

function Wait(Delay: number): Promise<void> {
  return new Promise((Resolve) => setTimeout(Resolve, Delay))
}

export async function WaitForPurge(Github: GithubClient, ReleaseValue: Release, GlobalpingApiToken: string, ProxyDispatcher?: Dispatcher): Promise<void> {
  const CommitSha = await Github.ResolveCommit(ReleaseValue.Repository, ReleaseValue.TargetCommitish)
  const Url = SubscriptionUrlFromPackageJson(await Github.PackageJson(ReleaseValue.Repository, CommitSha))
  if (Url === null) return

  const Deadline = Date.now() + PollTimeoutMs
  const RerunJobs = new Set<number>()
  while (Date.now() < Deadline) {
    const Jobs = await Github.PurgeJobs(ReleaseValue.Repository, CommitSha)
    if (Jobs.some((Job) => Job.Name === PurgeJobName && Job.Conclusion === 'success')) return ConfirmCdn(Url, GlobalpingApiToken, ProxyDispatcher)

    for (const Job of Jobs) {
      if (Job.Name === PurgeJobName && Job.Status === 'completed' && !RerunJobs.has(Job.Id)) {
        RerunJobs.add(Job.Id)
        await Github.RerunJob(ReleaseValue.Repository, Job.Id)
      }
    }
    await Wait(PollIntervalMs)
  }
  throw new Error(`Timed out waiting for ${PurgeJobName} at ${CommitSha}`)
}