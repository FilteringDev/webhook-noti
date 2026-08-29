import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfirmCdn, SubscriptionUrlFromPackageJson } from '../../../apps/notifier/source/purge.js'

function FetchFrom(Responses: Response[]): typeof fetch {
  return (Input, Init) => {
    void Input
    void Init
    const ResponseValue = Responses.shift()
    if (ResponseValue === undefined) return Promise.reject(new Error('Unexpected fetch request'))
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
  const Requests: Array<{ Url: string, Init: RequestInit | undefined }> = []
  const Fetch: typeof fetch = (Input, Init) => {
    const RequestUrl = typeof Input === 'string' ? Input : Input instanceof URL ? Input.href : Input.url
    Requests.push({ Url: RequestUrl, Init })
    if (Requests.length === 1) return Promise.resolve(new Response(JSON.stringify({ id: 'measurement-id' }), { status: 202 }))
    return Promise.resolve(new Response(JSON.stringify({ status: 'finished', results: [{ result: { statusCode: 200 } }] }), { status: 200 }))
  }

  await ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/dist/script.user.js?raw=1'), 'token-value', undefined, Fetch)

  assert.equal(Requests.length, 2)
  assert.equal(Requests[0]?.Url, 'https://api.globalping.io/v1/measurements')
  assert.equal(Requests[0]?.Init?.headers instanceof Object && (Requests[0].Init.headers as Record<string, string>).authorization, 'Bearer token-value')
  assert.deepEqual(JSON.parse(Requests[0]?.Init?.body as string), {
    type: 'http',
    target: 'cdn.jsdelivr.net',
    locations: [{ magic: 'World' }],
    measurementOptions: { protocol: 'HTTPS', request: { method: 'HEAD', path: '/npm/acme@latest/dist/script.user.js?raw=1' } }
  })
  assert.equal(Requests[1]?.Url, 'https://api.globalping.io/v1/measurements/measurement-id')
})

test('rejects completed Globalping measurements without a successful probe', async () => {
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), 'token-value', undefined, FetchFrom([
      new Response(JSON.stringify({ id: 'measurement-id' }), { status: 202 }),
      new Response(JSON.stringify({ status: 'finished', results: [{ result: { statusCode: 404 } }] }), { status: 200 })
    ])),
    /without a successful HTTP response/
  )
})

test('rejects unsuccessful Globalping API responses', async () => {
  await assert.rejects(
    ConfirmCdn(new URL('https://cdn.jsdelivr.net/npm/acme@latest/script.user.js'), 'token-value', undefined, FetchFrom([new Response(null, { status: 401 })])),
    /Globalping API returned HTTP 401/
  )
})