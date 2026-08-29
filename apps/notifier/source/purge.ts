import { SecureReq } from '@typescriptprime/securereq'
import type { Release } from '@webhook-noti/core'
import type { GithubClient } from './github.js'

const PurgeJobName = 'Purge jsdelivr cache'
const PollIntervalMs = 5_000
const PollTimeoutMs = 10 * 60_000

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

async function ConfirmCdn(Url: URL): Promise<void> {
  const Client = new SecureReq()
  try {
    const Response = await Client.Request(Url, { ExpectedAs: 'ArrayBuffer', FollowRedirects: false, HttpMethod: 'HEAD', TimeoutMs: 10_000 })
    if (Response.StatusCode < 200 || Response.StatusCode >= 300) throw new Error(`Subscription URL returned HTTP ${Response.StatusCode}`)
  } finally {
    Client.Close()
  }
}

function Wait(Delay: number): Promise<void> {
  return new Promise((Resolve) => setTimeout(Resolve, Delay))
}

export async function WaitForPurge(Github: GithubClient, ReleaseValue: Release): Promise<void> {
  const CommitSha = await Github.ResolveCommit(ReleaseValue.Repository, ReleaseValue.TargetCommitish)
  const Url = SubscriptionUrlFromPackageJson(await Github.PackageJson(ReleaseValue.Repository, CommitSha))
  if (Url === null) return

  const Deadline = Date.now() + PollTimeoutMs
  const RerunJobs = new Set<number>()
  while (Date.now() < Deadline) {
    const Jobs = await Github.PurgeJobs(ReleaseValue.Repository, CommitSha)
    if (Jobs.some((Job) => Job.Name === PurgeJobName && Job.Conclusion === 'success')) return ConfirmCdn(Url)

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