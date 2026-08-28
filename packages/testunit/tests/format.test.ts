import assert from 'node:assert/strict'
import test from 'node:test'
import { safeReleaseMessage, type Release } from '@webhook-noti/core'

const release: Release = {
  repository: { owner: 'acme', name: 'widget' },
  title: 'Release @everyone',
  tag: 'v1.2.3',
  body: 'Fixes #42 and acme/api#9. Visit #general. <@12345>',
  author: 'octo',
  url: 'https://github.com/acme/widget/releases/tag/v1.2.3',
  isPrerelease: false
}

test('renders plain text, full GitHub URLs, and neutralized mentions', async () => {
  const message = await safeReleaseMessage(release, async (reference) => reference.number === 42 ? 'pull' : 'issue')

  assert.match(message, /https:\/\/github\.com\/acme\/widget\/pull\/42/)
  assert.match(message, /https:\/\/github\.com\/acme\/api\/issues\/9/)
  assert.ok(!message.includes('@everyone'))
  assert.ok(!message.includes('#general'))
  assert.match(message, /@\u200beveryone/)
  assert.match(message, /#\u200bgeneral/)
})