import assert from 'node:assert/strict'
import test from 'node:test'
import { ReplyWithFailure } from '../../../apps/notifier/source/discord-response.js'

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