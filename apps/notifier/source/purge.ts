import { SecureReq } from '@typescriptprime/securereq'
import type { Release } from '@webhook-noti/core'
import { connect, type Socket } from 'node:net'
import type { GithubClient } from './github.js'

const PurgeJobName = 'Purge jsdelivr cache'
const PollIntervalMs = 5_000
const PollTimeoutMs = 10 * 60_000
const InitialPropagationDelayMs = 10_000
const RequestedProbeCount = 100
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

interface GlobalpingRequestOptions {
  CreateConnection?: (Options: { Hostname: string, Port: number }) => Promise<Socket>
  ExpectedAs: 'JSON'
  HttpHeaders: Record<string, string>
  HttpMethod?: 'GET' | 'POST'
  Payload?: string
}

type GlobalpingRequest = (Url: URL, Options: GlobalpingRequestOptions) => Promise<{ StatusCode: number, Body: unknown }>

function ConnectTunnel(ProxyUrl: string, Hostname: string, Port: number): Promise<Socket> {
  const Proxy = new URL(ProxyUrl)
  if (Proxy.protocol !== 'http:' || Proxy.hostname.length === 0 || Proxy.port.length === 0) {
    return Promise.reject(new Error('SOCKS bridge must use an HTTP URL with a host and port'))
  }
  return new Promise((Resolve, Reject) => {
    const SocketValue = connect({ host: Proxy.hostname, port: Number(Proxy.port) })
    let Response = ''
    const RejectAndDestroy = (ErrorValue: Error): void => {
      SocketValue.destroy()
      Reject(ErrorValue)
    }
    SocketValue.once('error', Reject)
    SocketValue.once('connect', () => SocketValue.write(`CONNECT ${Hostname}:${Port} HTTP/1.1\r\nHost: ${Hostname}:${Port}\r\n\r\n`))
    SocketValue.on('data', (Chunk: Buffer) => {
      Response += Chunk.toString('latin1')
      const HeaderEnd = Response.indexOf('\r\n\r\n')
      if (HeaderEnd === -1) return
      SocketValue.removeAllListeners('data')
      if (!/^HTTP\/1\.[01] 200\b/.test(Response.slice(0, HeaderEnd))) {
        RejectAndDestroy(new Error(`SOCKS bridge rejected CONNECT tunnel: ${Response.slice(0, HeaderEnd).split('\r\n')[0]}`))
        return
      }
      Resolve(SocketValue)
    })
  })
}

async function SecureRequest(Url: URL, Options: GlobalpingRequestOptions): Promise<{ StatusCode: number, Body: unknown }> {
  const Client = new SecureReq()
  try {
    return await Client.Request(Url, Options)
  } finally {
    Client.Close()
  }
}

async function GlobalpingResponse(Request: GlobalpingRequest, Url: URL, Options: GlobalpingRequestOptions): Promise<unknown> {
  const Response = await Request(Url, Options)
  if (Response.StatusCode < 200 || Response.StatusCode >= 300) throw new Error(`Globalping API returned HTTP ${Response.StatusCode}`)
  return Response.Body
}

/* oxlint-disable crackle/pascal-case */

function MeasurementId(Value: unknown): string {
  if (typeof Value !== 'object' || Value === null || typeof (Value as { id?: unknown }).id !== 'string') {
    throw new Error('Globalping API did not return a measurement ID')
  }
  return (Value as { id: string }).id
}

function UserscriptVersion(Value: string): string | null {
  const Match = /^\s*\/\/\s*@version\s+(\S+)\s*$/m.exec(Value)
  if (Match?.[1] === undefined) return null
  return Match[1].replace(/^v/, '')
}

function ReleaseVersion(Tag: string): string {
  const Version = Tag.replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(Version)) {
    throw new Error(`Release tag is not a semver version: ${Tag}`)
  }
  return Version
}

function HasConvergedProbes(Value: unknown, ExpectedVersion: string): boolean {
  if (typeof Value !== 'object' || Value === null || !Array.isArray((Value as { results?: unknown }).results)) return false
  const Results = (Value as { results: unknown[] }).results
  if (Results.length !== RequestedProbeCount) return false
  let KoreanProbeCount = 0
  let UnitedStatesProbeCount = 0
  return Results.every((Result) => {
    if (typeof Result !== 'object' || Result === null) return false
    const HttpResult = (Result as { result?: unknown }).result
    const Country = (Result as { probe?: { country?: unknown } }).probe?.country
    if (typeof HttpResult !== 'object' || HttpResult === null || typeof (HttpResult as { statusCode?: unknown }).statusCode !== 'number' || typeof (HttpResult as { body?: unknown }).body !== 'string') return false
    const StatusCode = (HttpResult as { statusCode: number }).statusCode
    if (StatusCode < 200 || StatusCode >= 300 || UserscriptVersion((HttpResult as { body: string }).body) !== ExpectedVersion) return false
    if (Country === 'KR') KoreanProbeCount += 1
    if (Country === 'US') UnitedStatesProbeCount += 1
    return true
  }) && KoreanProbeCount >= 10 && UnitedStatesProbeCount >= 10
}

function MeasurementFinished(Value: unknown): boolean {
  if (typeof Value !== 'object' || Value === null || typeof (Value as { status?: unknown }).status !== 'string') return false
  const Status = (Value as { status: string }).status.toLowerCase()
  return Status === 'finished' || Status === 'completed'
}

class CdnNotConvergedError extends Error {}

export async function ConfirmCdn(Url: URL, ReleaseTag: string, ApiToken: string, ProxyUrl?: string, Request: GlobalpingRequest = SecureRequest): Promise<void> {
  const ExpectedVersion = ReleaseVersion(ReleaseTag)
  const RequestPath = `${Url.pathname}${Url.search}`
  const CreateConnection = ProxyUrl === undefined ? undefined : (Options: { Hostname: string, Port: number }) => ConnectTunnel(ProxyUrl, Options.Hostname, Options.Port)
  const Headers = { authorization: `Bearer ${ApiToken}`, 'content-type': 'application/json' }
  const Id = MeasurementId(await GlobalpingResponse(Request, new URL(GlobalpingApiUrl), {
    ...(CreateConnection === undefined ? {} : { CreateConnection }),
    ExpectedAs: 'JSON',
    HttpHeaders: Headers,
    HttpMethod: 'POST',
    Payload: JSON.stringify({
      type: 'http',
      target: Url.hostname,
      locations: [{ country: 'KR', limit: 10 }, { country: 'US', limit: 10 }, { magic: 'World', limit: 80 }],
      measurementOptions: { protocol: 'HTTPS', request: { method: 'GET', path: RequestPath } }
    })
  }))
  const Deadline = Date.now() + PollTimeoutMs
  while (Date.now() < Deadline) {
    const Measurement = await GlobalpingResponse(Request, new URL(`${GlobalpingApiUrl}/${Id}`), { ...(CreateConnection === undefined ? {} : { CreateConnection }), ExpectedAs: 'JSON', HttpHeaders: Headers })
    if (HasConvergedProbes(Measurement, ExpectedVersion)) return
    if (MeasurementFinished(Measurement)) throw new CdnNotConvergedError('Globalping measurement completed before CDN content converged')
    await Wait(PollIntervalMs)
  }
  throw new Error(`Timed out waiting for Globalping measurement ${Id}`)
}

/* oxlint-enable crackle/pascal-case */

function Wait(Delay: number): Promise<void> {
  return new Promise((Resolve) => setTimeout(Resolve, Delay))
}

export async function WaitForPurge(Github: GithubClient, ReleaseValue: Release, GlobalpingApiToken: string, ProxyUrl?: string, Request: GlobalpingRequest = SecureRequest, Delay: (DelayMs: number) => Promise<void> = Wait): Promise<void> {
  const CommitSha = await Github.ResolveCommit(ReleaseValue.Repository, ReleaseValue.TargetCommitish)
  const Url = SubscriptionUrlFromPackageJson(await Github.PackageJson(ReleaseValue.Repository, CommitSha))
  if (Url === null) return

  const Deadline = Date.now() + PollTimeoutMs
  const ProcessedAttempts = new Set<string>()
  let RerunCount = 0
  while (Date.now() < Deadline) {
    const Jobs = await Github.PurgeJobs(ReleaseValue.Repository, CommitSha)
    const Job = Jobs.filter((Candidate) => Candidate.Name === PurgeJobName).sort((Left, Right) => Right.RunAttempt - Left.RunAttempt || Right.Id - Left.Id)[0]
    if (Job !== undefined) {
      const Attempt = `${Job.RunAttempt}:${Job.Id}`
      if (Job.Conclusion === 'success' && !ProcessedAttempts.has(Attempt)) {
        ProcessedAttempts.add(Attempt)
        await Delay(RerunCount === 0 ? InitialPropagationDelayMs : RerunCount * InitialPropagationDelayMs + PollIntervalMs)
        try {
          await ConfirmCdn(Url, ReleaseValue.Tag, GlobalpingApiToken, ProxyUrl, Request)
          return
        } catch (CaughtError) {
          if (!(CaughtError instanceof CdnNotConvergedError)) throw CaughtError
          await Github.RerunJob(ReleaseValue.Repository, Job.Id)
          RerunCount += 1
        }
      } else if (Job.Status === 'completed' && !ProcessedAttempts.has(Attempt)) {
        ProcessedAttempts.add(Attempt)
        await Github.RerunJob(ReleaseValue.Repository, Job.Id)
        RerunCount += 1
      }
    }
    await Delay(PollIntervalMs)
  }
  throw new Error(`Timed out waiting for ${PurgeJobName} at ${CommitSha}`)
}