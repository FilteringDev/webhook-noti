import assert from 'node:assert/strict'
import { test } from 'vitest'
import { DiscordNotificationPayload } from '../../../apps/notifier/source/discord.js'
import { TelegramNotificationOptions } from '../../../apps/notifier/source/telegram.js'

test('suppresses Discord embeds while preserving notification safety and length limits', () => {
  const Payload = DiscordNotificationPayload('x'.repeat(2_001))

  assert.equal(Payload.content, 'x'.repeat(2_000))
  assert.deepEqual(Payload.allowedMentions, { parse: [] })
  assert.equal(Payload.flags, 4)
})

test('disables Telegram link previews without adding a topic to regular messages', () => {
  assert.deepEqual(TelegramNotificationOptions(null), {
    disable_web_page_preview: true
  })
})

test('disables Telegram link previews while preserving the forum topic', () => {
  assert.deepEqual(TelegramNotificationOptions(123), {
    message_thread_id: 123,
    disable_web_page_preview: true
  })
})
