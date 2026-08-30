import { SecureReq } from '@typescriptprime/securereq'
import type { Release } from '@webhook-noti/core'
import { connect, type Socket } from 'node:net'
import type { GithubClient } from './github.js'

const PurgeJobName = 'Purge jsdelivr cache'
const PollIntervalMs = 5_000
const PollTimeoutMs = 10 * 60_000
const MaxRerunCount = 2
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

interface GlobalpingResponseValue {
  Body: unknown
  Headers?: Record<string, string | string[] | undefined>
  StatusCode: number
}

interface GlobalpingResponseBody {
  Body: unknown
  Headers?: Record<string, string | string[] | undefined>
  StatusCode: number
}

type GlobalpingRequest = (Url: URL, Options: GlobalpingRequestOptions) => Promise<GlobalpingResponseValue>

type PurgeProgressFields = Record<string, boolean | number | string | undefined>

export interface PurgeProgress {
  Message: string
  [Key: string]: boolean | number | string | undefined
}

type PurgeProgressReporter = (Progress: PurgeProgress) => void

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

async function SecureRequest(Url: URL, Options: GlobalpingRequestOptions): Promise<GlobalpingResponseValue> {
  const Client = new SecureReq()
  try {
    return await Client.Request(Url, Options)
  } finally {
    Client.Close()
  }
}

async function GlobalpingResponse(Request: GlobalpingRequest, Url: URL, Options: GlobalpingRequestOptions): Promise<GlobalpingResponseBody> {
  const Response = await Request(Url, Options)
  if (Response.StatusCode < 200 || Response.StatusCode >= 300) throw Object.assign(new Error(`Globalping API returned HTTP ${Response.StatusCode}`), { Headers: Response.Headers, StatusCode: Response.StatusCode })
  return Response
}

function HeaderValue(Headers: Record<string, string | string[] | undefined> | undefined, Name: string): string | undefined {
  if (Headers === undefined) return undefined
  const HeaderName = Name.toLowerCase()
  for (const [Key, Value] of Object.entries(Headers)) {
    if (Key.toLowerCase() !== HeaderName) continue
    if (typeof Value === 'string') return Value
    if (Array.isArray(Value)) return Value.filter((Item) => typeof Item === 'string').join(', ')
  }
  return undefined
}

function GlobalpingHeaderProgress(Headers: Record<string, string | string[] | undefined> | undefined): PurgeProgressFields {
  return {
    ...(HeaderValue(Headers, 'Location') === undefined ? {} : { GlobalpingLocation: HeaderValue(Headers, 'Location') }),
    ...(HeaderValue(Headers, 'X-RateLimit-Limit') === undefined ? {} : { GlobalpingRateLimitLimit: HeaderValue(Headers, 'X-RateLimit-Limit') }),
    ...(HeaderValue(Headers, 'X-RateLimit-Consumed') === undefined ? {} : { GlobalpingRateLimitConsumed: HeaderValue(Headers, 'X-RateLimit-Consumed') }),
    ...(HeaderValue(Headers, 'X-RateLimit-Remaining') === undefined ? {} : { GlobalpingRateLimitRemaining: HeaderValue(Headers, 'X-RateLimit-Remaining') }),
    ...(HeaderValue(Headers, 'X-RateLimit-Reset') === undefined ? {} : { GlobalpingRateLimitReset: HeaderValue(Headers, 'X-RateLimit-Reset') }),
    ...(HeaderValue(Headers, 'X-Credits-Consumed') === undefined ? {} : { GlobalpingCreditsConsumed: HeaderValue(Headers, 'X-Credits-Consumed') }),
    ...(HeaderValue(Headers, 'X-Credits-Remaining') === undefined ? {} : { GlobalpingCreditsRemaining: HeaderValue(Headers, 'X-Credits-Remaining') }),
    ...(HeaderValue(Headers, 'X-Request-Cost') === undefined ? {} : { GlobalpingRequestCost: HeaderValue(Headers, 'X-Request-Cost') })
  }
}

function ObjectValue(Value: unknown): Record<string, unknown> | undefined {
  return Value !== null && typeof Value === 'object' ? Value as Record<string, unknown> : undefined
}

function HeaderRecord(Value: unknown): Record<string, string | string[] | undefined> | undefined {
  const RecordValue = ObjectValue(Value)
  if (RecordValue === undefined) return undefined
  return Object.fromEntries(Object.entries(RecordValue).filter(([, ValueItem]) => typeof ValueItem === 'string' || ValueItem === undefined || (Array.isArray(ValueItem) && ValueItem.every((Item) => typeof Item === 'string')))) as Record<string, string | string[] | undefined>
}

function ErrorProgress(CaughtError: unknown): PurgeProgressFields {
  const ErrorValue = ObjectValue(CaughtError)
  const StatusCode = ErrorValue?.StatusCode ?? ErrorValue?.statusCode ?? ErrorValue?.status
  const Headers = HeaderRecord(ErrorValue?.Headers ?? ErrorValue?.headers)
  return {
    ErrorMessage: CaughtError instanceof Error ? CaughtError.message : 'Unknown Globalping API error',
    ...(typeof StatusCode === 'number' ? { StatusCode } : {}),
    ...GlobalpingHeaderProgress(Headers)
  }
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

interface ProbeSummary {
  Converged: boolean
  ExpectedVersion: string
  HttpFailureCount: number
  InvalidProbeCount: number
  KoreanProbeCount: number
  MatchingVersionCount: number
  MissingVersionCount: number
  MismatchedVersionCount: number
  ProbeCount: number
  UnitedStatesProbeCount: number
}

function ProbeSummaryFrom(Value: unknown, ExpectedVersion: string): ProbeSummary {
  if (typeof Value !== 'object' || Value === null || !Array.isArray((Value as { results?: unknown }).results)) {
    return { Converged: false, ExpectedVersion, HttpFailureCount: 0, InvalidProbeCount: 0, KoreanProbeCount: 0, MatchingVersionCount: 0, MissingVersionCount: 0, MismatchedVersionCount: 0, ProbeCount: 0, UnitedStatesProbeCount: 0 }
  }
  const Results = (Value as { results: unknown[] }).results
  let KoreanProbeCount = 0
  let UnitedStatesProbeCount = 0
  let MatchingVersionCount = 0
  let MismatchedVersionCount = 0
  let HttpFailureCount = 0
  let MissingVersionCount = 0
  let InvalidProbeCount = 0
  for (const Result of Results) {
    if (typeof Result !== 'object' || Result === null) {
      InvalidProbeCount += 1
      continue
    }
    const HttpResult = (Result as { result?: unknown }).result
    const Country = (Result as { probe?: { country?: unknown } }).probe?.country
    if (typeof HttpResult !== 'object' || HttpResult === null || typeof (HttpResult as { statusCode?: unknown }).statusCode !== 'number' || typeof (HttpResult as { body?: unknown }).body !== 'string') {
      InvalidProbeCount += 1
      continue
    }
    const StatusCode = (HttpResult as { statusCode: number }).statusCode
    if (StatusCode < 200 || StatusCode >= 300) {
      HttpFailureCount += 1
      continue
    }
    const Version = UserscriptVersion((HttpResult as { body: string }).body)
    if (Version === null) {
      MissingVersionCount += 1
      continue
    }
    if (Version !== ExpectedVersion) {
      MismatchedVersionCount += 1
      continue
    }
    MatchingVersionCount += 1
    if (Country === 'KR') KoreanProbeCount += 1
    if (Country === 'US') UnitedStatesProbeCount += 1
  }
  const Converged = Results.length === RequestedProbeCount && InvalidProbeCount === 0 && HttpFailureCount === 0 && MissingVersionCount === 0 && MismatchedVersionCount === 0 && KoreanProbeCount >= 10 && UnitedStatesProbeCount >= 10
  return { Converged, ExpectedVersion, HttpFailureCount, InvalidProbeCount, KoreanProbeCount, MatchingVersionCount, MissingVersionCount, MismatchedVersionCount, ProbeCount: Results.length, UnitedStatesProbeCount }
}

function MeasurementFinished(Value: unknown): boolean {
  if (typeof Value !== 'object' || Value === null || typeof (Value as { status?: unknown }).status !== 'string') return false
  const Status = (Value as { status: string }).status.toLowerCase()
  return Status === 'finished' || Status === 'completed'
}

class CdnNotConvergedError extends Error {}

function MeasurementStatus(Value: unknown): string | undefined {
  if (typeof Value !== 'object' || Value === null || typeof (Value as { status?: unknown }).status !== 'string') return undefined
  return (Value as { status: string }).status
}

export async function ConfirmCdn(Url: URL, ReleaseTag: string, ApiToken: string, ProxyUrl?: string, Request: GlobalpingRequest = SecureRequest, OnProgress?: PurgeProgressReporter): Promise<void> {
  const ExpectedVersion = ReleaseVersion(ReleaseTag)
  const RequestPath = `${Url.pathname}${Url.search}`
  const CreateConnection = ProxyUrl === undefined ? undefined : (Options: { Hostname: string, Port: number }) => ConnectTunnel(ProxyUrl, Options.Hostname, Options.Port)
  const Headers = { authorization: `Bearer ${ApiToken}`, 'content-type': 'application/json' }
  const Target = Url.hostname
  const ProxyEnabled = ProxyUrl !== undefined
  OnProgress?.({ Message: 'Globalping verification started', ExpectedVersion, Target, RequestPath, ProxyEnabled })
  OnProgress?.({ Message: 'Globalping measurement creation started', ExpectedVersion, Target, RequestPath, ProxyEnabled })
  let Creation: GlobalpingResponseBody
  try {
    Creation = await GlobalpingResponse(Request, new URL(GlobalpingApiUrl), {
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
    })
  } catch (CaughtError) {
    OnProgress?.({ Message: 'Globalping measurement creation failed', ExpectedVersion, Target, RequestPath, ProxyEnabled, ...ErrorProgress(CaughtError) })
    throw CaughtError
  }
  const Id = MeasurementId(Creation.Body)
  OnProgress?.({ Message: 'Globalping measurement created', MeasurementId: Id, ExpectedVersion, Target, RequestPath, ProxyEnabled, ...GlobalpingHeaderProgress(Creation.Headers) })
  const Deadline = Date.now() + PollTimeoutMs
  let PollAttempt = 0
  while (Date.now() < Deadline) {
    PollAttempt += 1
    let Measurement: GlobalpingResponseBody
    try {
      Measurement = await GlobalpingResponse(Request, new URL(`${GlobalpingApiUrl}/${Id}`), { ...(CreateConnection === undefined ? {} : { CreateConnection }), ExpectedAs: 'JSON', HttpHeaders: Headers })
    } catch (CaughtError) {
      OnProgress?.({ Message: 'Globalping measurement poll failed', MeasurementId: Id, PollAttempt, ...ErrorProgress(CaughtError) })
      throw CaughtError
    }
    const Summary = ProbeSummaryFrom(Measurement.Body, ExpectedVersion)
    const Status = MeasurementStatus(Measurement.Body)
    OnProgress?.({ Message: 'Globalping measurement polled', MeasurementId: Id, PollAttempt, Status, ...Summary, ...GlobalpingHeaderProgress(Measurement.Headers) })
    if (Summary.Converged) {
      OnProgress?.({ Message: 'Globalping measurement converged', MeasurementId: Id, PollAttempt, ...Summary })
      return
    }
    if (MeasurementFinished(Measurement.Body)) {
      OnProgress?.({ Message: 'Globalping measurement completed without convergence', MeasurementId: Id, PollAttempt, Status, ...Summary })
      throw new CdnNotConvergedError('Globalping measurement completed before CDN content converged')
    }
    await Wait(PollIntervalMs)
  }
  OnProgress?.({ Message: 'Globalping measurement timed out', MeasurementId: Id, PollAttempt, TimeoutMs: PollTimeoutMs })
  throw new Error(`Timed out waiting for Globalping measurement ${Id}`)
}

/* oxlint-enable crackle/pascal-case */

function Wait(Delay: number): Promise<void> {
  return new Promise((Resolve) => setTimeout(Resolve, Delay))
}

export async function WaitForPurge(Github: GithubClient, ReleaseValue: Release, GlobalpingApiToken: string, ProxyUrl?: string, Request: GlobalpingRequest = SecureRequest, Delay: (DelayMs: number) => Promise<void> = Wait, OnProgress?: PurgeProgressReporter): Promise<void> {
  const CommitSha = await Github.ResolveCommit(ReleaseValue.Repository, ReleaseValue.TargetCommitish)
  const Url = SubscriptionUrlFromPackageJson(await Github.PackageJson(ReleaseValue.Repository, CommitSha))
  if (Url === null) {
    OnProgress?.({ Message: 'Purge verification skipped', Reason: 'Subscription URL was not configured' })
    return
  }

  const Deadline = Date.now() + PollTimeoutMs
  const ProcessedAttempts = new Set<string>()
  let RerunCount = 0
  let PollAttempt = 0
  while (Date.now() < Deadline) {
    PollAttempt += 1
    const Jobs = await Github.PurgeJobs(ReleaseValue.Repository, CommitSha)
    const Job = Jobs.filter((Candidate) => Candidate.Name === PurgeJobName).sort((Left, Right) => Right.RunAttempt - Left.RunAttempt || Right.Id - Left.Id)[0]
    OnProgress?.({
      Message: Job === undefined ? 'Purge job not found' : 'Purge job polled',
      PollAttempt,
      JobCount: Jobs.length,
      RerunCount,
      CommitSha,
      ...(Job === undefined ? {} : { JobId: Job.Id, RunAttempt: Job.RunAttempt, Status: Job.Status, Conclusion: Job.Conclusion ?? undefined })
    })
    if (Job !== undefined) {
      const Attempt = `${Job.RunAttempt}:${Job.Id}`
      if (Job.Conclusion === 'success' && !ProcessedAttempts.has(Attempt)) {
        ProcessedAttempts.add(Attempt)
        const PropagationDelayMs = RerunCount * 90_000 + 120_000
        if (RerunCount >= MaxRerunCount || Date.now() + PropagationDelayMs >= Deadline) {
          OnProgress?.({ Message: 'Purge verification gave up before CDN confirmation; proceeding without it', PollAttempt, JobId: Job.Id, RunAttempt: Job.RunAttempt, RerunCount, PropagationDelayMs })
          return
        }
        OnProgress?.({ Message: 'Purge job succeeded; waiting for CDN propagation', PollAttempt, JobId: Job.Id, RunAttempt: Job.RunAttempt, PropagationDelayMs, RerunCount })
        await Delay(PropagationDelayMs)
        OnProgress?.({ Message: 'CDN propagation wait completed', PollAttempt, JobId: Job.Id, RunAttempt: Job.RunAttempt, PropagationDelayMs, RerunCount })
        OnProgress?.({ Message: 'CDN verification started', PollAttempt, JobId: Job.Id, RunAttempt: Job.RunAttempt, RerunCount })
        try {
          await ConfirmCdn(Url, ReleaseValue.Tag, GlobalpingApiToken, ProxyUrl, Request, OnProgress)
          OnProgress?.({ Message: 'Purge verification completed', PollAttempt, JobId: Job.Id, RunAttempt: Job.RunAttempt, RerunCount })
          return
        } catch (CaughtError) {
          if (!(CaughtError instanceof CdnNotConvergedError)) throw CaughtError
          OnProgress?.({ Message: 'Purge job rerun requested after CDN did not converge', PollAttempt, JobId: Job.Id, RunAttempt: Job.RunAttempt, RerunCount, NextRerunCount: RerunCount + 1 })
          await Github.RerunJob(ReleaseValue.Repository, Job.Id)
          RerunCount += 1
        }
      } else if (Job.Status === 'completed' && !ProcessedAttempts.has(Attempt)) {
        ProcessedAttempts.add(Attempt)
        if (RerunCount >= MaxRerunCount) {
          OnProgress?.({ Message: 'Purge verification gave up after unsuccessful completion; proceeding without it', PollAttempt, JobId: Job.Id, RunAttempt: Job.RunAttempt, Conclusion: Job.Conclusion ?? undefined, RerunCount })
          return
        }
        OnProgress?.({ Message: 'Purge job rerun requested after unsuccessful completion', PollAttempt, JobId: Job.Id, RunAttempt: Job.RunAttempt, Conclusion: Job.Conclusion ?? undefined, RerunCount })
        await Github.RerunJob(ReleaseValue.Repository, Job.Id)
        RerunCount += 1
      }
    }
    await Delay(PollIntervalMs)
  }
  OnProgress?.({ Message: 'Purge verification timed out', PollAttempt, CommitSha, RerunCount, TimeoutMs: PollTimeoutMs })
  throw new Error(`Timed out waiting for ${PurgeJobName} at ${CommitSha}`)
}