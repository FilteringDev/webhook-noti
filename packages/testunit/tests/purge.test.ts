import assert from 'node:assert/strict'
import test from 'node:test'
import type { Release } from '@webhook-noti/core'
import { ConfirmCdn, SubscriptionUrlFromPackageJson, WaitForPurge } from '../../../apps/notifier/source/purge.js'

type GlobalpingRequest = Exclude<Parameters<typeof ConfirmCdn>[4], undefined>
type GlobalpingRequestOptions = Parameters<GlobalpingRequest>[1]

function MatchingResults(Country: 'KR' | 'US' | 'DE' = 'DE', Count = 1, Version = '1.2.3'): unknown[] {
  return Array.from({ length: Count }, () => ({ probe: { country: Country }, result: { statusCode: 200, body: `// @version ${Version}\n` } }))
}

function RequestFrom(Responses: Array<{ StatusCode: number, Body: unknown }>): GlobalpingRequest {
  return (Url, Options) => {
    void Url
    void Options
    const ResponseValue = Responses.shift()
    if (ResponseValue === undefined) return Promise.reject(new Error('Unexpected SecureReq request'))
    return Promise.resolve(ResponseValue)
  }
}

test('does not classify package scripts without a SubscriptionUrl as userscripts', () => {
  assert.equal(SubscriptionUrlFromPackageJson(JSON.stringify({ scripts: { build: 'pnpm build' } })), null)
})

test('extracts HTTPS SubscriptionUrl from a userscript build script', () => {
  const Url = SubscriptionUrlFromPackageJson(JSON.stringify({ scripts: { build: 'pnpm build --SubscriptionUrl https://cdn.jsdelivr.net/npm/acme@latest/dist/script.user.js' } }))
  assert.equal(Url?.href, 'https://cdn.jsdelivr.net/npm/acme@latest/dist/script.user.js')
})

test('rejects an insecure userscript SubscriptionUrl', () => {
  assert.throws(() => SubscriptionUrlFromPackageJson(JSON.stringify({ scripts: { build: 'pnpm build --SubscriptionUrl http://example.test/script.user.js' } })), /must use HTTPS/)
})

test('confirms a jsdelivr URL through 100 authenticated matching regional measurements', async () => {
  const Requests: Array<{ Url: URL, Options: GlobalpingRequestOptions }> = []
  const Progress: Array<{ Message: string, MeasurementId?: string, PollAttempt?: number, ProbeCount?: number }> = []
  const Request: GlobalpingRequest = (Url, Options) => {
    Requests.push({ Url, Options })
    if (Requests.length === 1) return Promise.resolve({ StatusCode: 202, Body: { id: 'measurement-id' } })
    return Promise.resolve({ StatusCode: 200, Body: { status: 'finished', results: [...MatchingResults('KR', 10), ...MatchingResults('US', 10), ...MatchingResults('DE', 80)] } })
  }

  await ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/dist/script.user.js?raw=1'), 'v1.2.3', 'token-value', undefined, Request, (Event) => Progress.push(Event))

  assert.equal(Requests.length, 2)
  assert.equal(Requests[0]?.Url.href, 'https://api.globalping.io/v1/measurements')
  assert.equal(Requests[0]?.Options.HttpHeaders.authorization, 'Bearer token-value')
  assert.deepEqual(JSON.parse(Requests[0]?.Options.Payload as string), {
    type: 'http',
    target: 'cdn.jsdelivr.net',
    locations: [{ country: 'KR', limit: 10 }, { country: 'US', limit: 10 }, { magic: 'World', limit: 80 }],
    measurementOptions: { protocol: 'HTTPS', request: { method: 'GET', path: '/npm/acme@latest/dist/script.user.js?raw=1' } }
  })
  assert.equal(Requests[1]?.Url.href, 'https://api.globalping.io/v1/measurements/measurement-id')
  assert.deepEqual(Progress, [
    { Message: 'Globalping measurement created', MeasurementId: 'measurement-id', ExpectedVersion: '1.2.3' },
    { Message: 'Globalping measurement polled', MeasurementId: 'measurement-id', PollAttempt: 1, Status: 'finished', ProbeCount: 100, Converged: true },
    { Message: 'Globalping measurement converged', MeasurementId: 'measurement-id', PollAttempt: 1, ProbeCount: 100 }
  ])
})

test('uses a CONNECT tunnel when a SOCKS bridge URL is provided', async () => {
  const Requests: GlobalpingRequestOptions[] = []
  const Request: GlobalpingRequest = (Url, Options) => {
    void Url
    Requests.push(Options)
    if (Requests.length === 1) return Promise.resolve({ StatusCode: 202, Body: { id: 'measurement-id' } })
    return Promise.resolve({ StatusCode: 200, Body: { status: 'finished', results: [...MatchingResults('KR', 10), ...MatchingResults('US', 10), ...MatchingResults('DE', 80)] } })
  }

  await ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), '1.2.3', 'token-value', 'http://127.0.0.1:8080', Request)

  assert.notEqual(Requests[0]?.CreateConnection, undefined)
})

test('rejects completed Globalping measurements with mismatched userscript versions', async () => {
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), '1.2.3', 'token-value', undefined, RequestFrom([
      { StatusCode: 202, Body: { id: 'measurement-id' } },
      { StatusCode: 200, Body: { status: 'finished', results: [...MatchingResults('KR', 10), ...MatchingResults('US', 10), ...MatchingResults('DE', 80, '1.2.2')] } }
    ])),
    /before CDN content converged/
  )
})

test('rejects completed Globalping measurements without 10 matching probes in each requested region', async () => {
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), '1.2.3', 'token-value', undefined, RequestFrom([
      { StatusCode: 202, Body: { id: 'measurement-id' } },
      { StatusCode: 200, Body: { status: 'finished', results: [...MatchingResults('KR', 9), ...MatchingResults('US', 10), ...MatchingResults('DE', 81)] } }
    ])),
    /before CDN content converged/
  )
})

test('rejects incomplete Globalping measurements and bodies without userscript versions', async () => {
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), '1.2.3', 'token-value', undefined, RequestFrom([
      { StatusCode: 202, Body: { id: 'measurement-id' } },
      { StatusCode: 200, Body: { status: 'finished', results: MatchingResults('KR', 10).concat(MatchingResults('US', 10), MatchingResults('DE', 79)) } }
    ])),
    /before CDN content converged/
  )
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), '1.2.3', 'token-value', undefined, RequestFrom([
      { StatusCode: 202, Body: { id: 'measurement-id' } },
      { StatusCode: 200, Body: { status: 'finished', results: [...MatchingResults('KR', 10), ...MatchingResults('US', 10), ...Array.from({ length: 80 }, () => ({ probe: { country: 'DE' }, result: { statusCode: 200, body: '// userscript body\n' } }))] } }
    ])),
    /before CDN content converged/
  )
})

test('reruns an unconverged purge job and waits longer before checking its new attempt', async () => {
  const Delays: number[] = []
  const RerunJobIds: number[] = []
  const Progress: Array<{ Message: string, PollAttempt?: number, JobId?: number, RerunCount?: number }> = []
  const ReleaseValue: Release = {
    Repository: { Owner: 'acme', Name: 'userscript' },
    Title: 'Release',
    Tag: 'v1.2.3',
    Body: '',
    Author: 'octocat',
    Url: 'https://github.com/acme/userscript/releases/tag/v1.2.3',
    IsPrerelease: false,
    TargetCommitish: 'v1.2.3'
  }
  let PurgeJobCalls = 0
  const Github = {
    ResolveCommit: async () => '0123456789012345678901234567890123456789',
    PackageJson: async () => JSON.stringify({ scripts: { build: 'build --SubscriptionUrl https://cdn.jsdelivr.net/npm/acme@latest/script.user.js' } }),
    PurgeJobs: async () => {
      PurgeJobCalls += 1
      return PurgeJobCalls === 1
        ? [{ Id: 1, Name: 'Purge jsdelivr cache', Status: 'completed', Conclusion: 'success', RunAttempt: 1 }]
        : [{ Id: 2, Name: 'Purge jsdelivr cache', Status: 'completed', Conclusion: 'success', RunAttempt: 2 }]
    },
    RerunJob: async (RepositoryValue: Release['Repository'], JobId: number) => {
      void RepositoryValue
      RerunJobIds.push(JobId)
    }
  } as unknown as Parameters<typeof WaitForPurge>[0]
  const Request = RequestFrom([
    { StatusCode: 202, Body: { id: 'first-measurement' } },
    { StatusCode: 200, Body: { status: 'finished', results: [...MatchingResults('KR', 10), ...MatchingResults('US', 10), ...MatchingResults('DE', 80, '1.2.2')] } },
    { StatusCode: 202, Body: { id: 'second-measurement' } },
    { StatusCode: 200, Body: { status: 'finished', results: [...MatchingResults('KR', 10), ...MatchingResults('US', 10), ...MatchingResults('DE', 80)] } }
  ])

  await WaitForPurge(Github, ReleaseValue, 'token-value', undefined, Request, async (DelayMs) => { Delays.push(DelayMs) }, (Event) => Progress.push(Event))

  assert.deepEqual(RerunJobIds, [1])
  assert.deepEqual(Delays, [10_000, 5_000, 15_000])
  assert.equal(Progress.filter((Event) => Event.Message === 'Purge job polled').length, 2)
  assert.deepEqual(Progress.find((Event) => Event.Message === 'Purge job rerun requested after CDN did not converge'), {
    Message: 'Purge job rerun requested after CDN did not converge', PollAttempt: 1, JobId: 1, RunAttempt: 1, RerunCount: 0
  })
  assert.deepEqual(Progress.at(-1), {
    Message: 'Purge verification completed', PollAttempt: 2, JobId: 2, RunAttempt: 2, RerunCount: 1
  })
})

test('rejects unsuccessful Globalping API responses', async () => {
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), '1.2.3', 'token-value', undefined, RequestFrom([{ StatusCode: 401, Body: null }])),
    /Globalping API returned HTTP 401/
  )
})