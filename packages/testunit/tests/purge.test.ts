import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfirmCdn, SubscriptionUrlFromPackageJson } from '../../../apps/notifier/source/purge.js'

type GlobalpingRequest = Exclude<Parameters<typeof ConfirmCdn>[3], undefined>
type GlobalpingRequestOptions = Parameters<GlobalpingRequest>[1]

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

test('confirms a jsdelivr URL through an authenticated successful World measurement', async () => {
  const Requests: Array<{ Url: URL, Options: GlobalpingRequestOptions }> = []
  const Request: GlobalpingRequest = (Url, Options) => {
    Requests.push({ Url, Options })
    if (Requests.length === 1) return Promise.resolve({ StatusCode: 202, Body: { id: 'measurement-id' } })
    return Promise.resolve({ StatusCode: 200, Body: { status: 'finished', results: [{ result: { statusCode: 200 } }] } })
  }

  await ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/dist/script.user.js?raw=1'), 'token-value', undefined, Request)

  assert.equal(Requests.length, 2)
  assert.equal(Requests[0]?.Url.href, 'https://api.globalping.io/v1/measurements')
  assert.equal(Requests[0]?.Options.HttpHeaders.authorization, 'Bearer token-value')
  assert.deepEqual(JSON.parse(Requests[0]?.Options.Payload as string), {
    type: 'http',
    target: 'cdn.jsdelivr.net',
    locations: [{ magic: 'World' }],
    measurementOptions: { protocol: 'HTTPS', request: { method: 'HEAD', path: '/npm/acme@latest/dist/script.user.js?raw=1' } }
  })
  assert.equal(Requests[1]?.Url.href, 'https://api.globalping.io/v1/measurements/measurement-id')
})

test('uses a CONNECT tunnel when a SOCKS bridge URL is provided', async () => {
  const Requests: GlobalpingRequestOptions[] = []
  const Request: GlobalpingRequest = (Url, Options) => {
    void Url
    Requests.push(Options)
    if (Requests.length === 1) return Promise.resolve({ StatusCode: 202, Body: { id: 'measurement-id' } })
    return Promise.resolve({ StatusCode: 200, Body: { status: 'finished', results: [{ result: { statusCode: 204 } }] } })
  }

  await ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), 'token-value', 'http://127.0.0.1:8080', Request)

  assert.notEqual(Requests[0]?.CreateConnection, undefined)
})

test('rejects completed Globalping measurements without a successful probe', async () => {
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), 'token-value', undefined, RequestFrom([
      { StatusCode: 202, Body: { id: 'measurement-id' } },
      { StatusCode: 200, Body: { status: 'finished', results: [{ result: { statusCode: 404 } }] } }
    ])),
    /without a successful HTTP response/
  )
})

test('rejects unsuccessful Globalping API responses', async () => {
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), 'token-value', undefined, RequestFrom([{ StatusCode: 401, Body: null }])),
    /Globalping API returned HTTP 401/
  )
})