import assert from 'node:assert/strict'
import test from 'node:test'
import { SubscriptionUrlFromPackageJson } from '../../../apps/notifier/source/purge.js'

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