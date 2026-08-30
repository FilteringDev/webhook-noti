import assert from 'node:assert/strict'
import test from 'node:test'
import { DiscordInteractionErrorDetails, ReplyWithFailure } from '../../../apps/notifier/source/discord-response.js'

test('replies to a failed fresh Discord interaction', async () => {
  const Calls: string[] = []

  await ReplyWithFailure({
    Deferred: false,
    Replied: false,
    EditReply: (Content) => { Calls.push(`edit:${Content}`); return Promise.resolve() },
    Reply: (Content) => { Calls.push(`reply:${Content}`); return Promise.resolve() }
  }, 'Unable to complete this request.')

  assert.deepEqual(Calls, ['reply:Unable to complete this request.'])
})

test('edits the deferred response for a failed Discord interaction', async () => {
  const Calls: string[] = []

  await ReplyWithFailure({
    Deferred: true,
    Replied: false,
    EditReply: (Content) => { Calls.push(`edit:${Content}`); return Promise.resolve() },
    Reply: (Content) => { Calls.push(`reply:${Content}`); return Promise.resolve() }
  }, 'Unable to complete this request.')

  assert.deepEqual(Calls, ['edit:Unable to complete this request.'])
})

test('does not respond again after a Discord interaction has completed', async () => {
  const Calls: string[] = []

  await ReplyWithFailure({
    Deferred: false,
    Replied: true,
    EditReply: (Content) => { Calls.push(`edit:${Content}`); return Promise.resolve() },
    Reply: (Content) => { Calls.push(`reply:${Content}`); return Promise.resolve() }
  }, 'Unable to complete this request.')

  assert.deepEqual(Calls, [])
})

test('extracts serializable details from Discord interaction errors', () => {
  const DiscordError = Object.assign(new Error('Missing Permissions'), { code: 50_013, status: 403 })

  assert.deepEqual(DiscordInteractionErrorDetails(DiscordError), { Code: 50_013, Detail: 'Missing Permissions', Status: 403 })
  assert.deepEqual(DiscordInteractionErrorDetails('connection reset'), { Code: undefined, Detail: 'connection reset', Status: undefined })
})