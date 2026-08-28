import assert from 'node:assert/strict'
import test from 'node:test'
import { SafeReleaseMessage, type Release } from '@webhook-noti/core'

const ReleaseValue: Release = {
  Repository: { Owner: 'acme', Name: 'widget' },
  Title: 'Release @everyone',
  Tag: 'v1.2.3',
  Body: 'Fixes #42 and acme/api#9. Visit #general. <@12345>',
  Author: 'octo',
  Url: 'https://github.com/acme/widget/releases/tag/v1.2.3',
  IsPrerelease: false
}

test('renders plain text, full GitHub URLs, and neutralized mentions', async () => {
  const Message = await SafeReleaseMessage(ReleaseValue, async (Reference) => Reference.Number === 42 ? 'pull' : 'issue')

  assert.match(Message, /https:\/\/github\.com\/acme\/widget\/pull\/42/)
  assert.match(Message, /https:\/\/github\.com\/acme\/api\/issues\/9/)
  assert.ok(!Message.includes('@everyone'))
  assert.ok(!Message.includes('#general'))
  assert.match(Message, /@\u200beveryone/)
  assert.match(Message, /#\u200bgeneral/)
})
