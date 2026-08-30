import assert from 'node:assert/strict'
import { test } from 'vitest'
import { RunGuarded } from '../../../apps/notifier/source/async-guard.js'
import { IsPermanentDestinationError, IsTransientError, Retry } from '../../../apps/notifier/source/delivery.js'
import { PollingErrorDetails } from '../../../apps/notifier/source/telegram.js'

test('reports rejected async event handlers without leaking the rejection', async () => {
  const Reported: unknown[] = []
  const Failure = new Error('TLS connection closed')

  RunGuarded(() => Promise.reject(Failure), (CaughtError) => Reported.push(CaughtError))

  await new Promise<void>((Resolve) => setImmediate(Resolve))
  assert.deepEqual(Reported, [Failure])
})

test('retries transient delivery failures', async () => {
  let Attempts = 0
  const Failures: unknown[] = []

  await Retry(() => {
    Attempts += 1
    if (Attempts === 1) throw Object.assign(new Error('socket disconnected'), { code: 'EFATAL' })
    return Promise.resolve()
  }, (UnusedAttempt, CaughtError) => {
    void UnusedAttempt
    Failures.push(CaughtError)
  }, [0])

  assert.equal(Attempts, 2)
  assert.equal(Failures.length, 1)
})

test('does not retry permanent delivery failures', async () => {
  for (const StatusCode of [400, 401, 403, 404]) {
    let Attempts = 0
    const Failure = Object.assign(new Error('permanent error'), { statusCode: StatusCode })

    await assert.rejects(() => Retry(() => {
      Attempts += 1
      throw Failure
    }, () => {}, [0]), Failure)

    assert.equal(Attempts, 1)
  }
})

test('uses bounded Retry-After delays for rate limits', async () => {
  let Attempts = 0

  await Retry(() => {
    Attempts += 1
    if (Attempts === 1) throw Object.assign(new Error('rate limited'), { headers: { 'retry-after': '0' }, statusCode: 429 })
    return Promise.resolve()
  }, () => {}, [0])
  assert.equal(Attempts, 2)

  const ExcessiveDelay = Object.assign(new Error('rate limited'), { headers: { 'retry-after': '31' }, statusCode: 429 })
  await assert.rejects(async () => Retry(async () => Promise.reject(ExcessiveDelay), () => {}, [0]), ExcessiveDelay)
  assert.equal(IsTransientError(ExcessiveDelay), true)
})

test('describes Telegram polling errors without logging request details', () => {
  const Failure = Object.assign(new Error('ETELEGRAM: 409 Conflict: terminated by other getUpdates request'), {
    code: 'ETELEGRAM',
    response: { statusCode: 409 }
  })

  assert.deepEqual(PollingErrorDetails(Failure), {
    Code: 'ETELEGRAM',
    Detail: 'ETELEGRAM: 409 Conflict: terminated by other getUpdates request',
    Status: 409
  })
})

test('keeps transient Telegram polling errors under the library retry loop', () => {
  const Failure = Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' })

  assert.deepEqual(PollingErrorDetails(Failure), {
    Code: 'ECONNRESET',
    Detail: 'socket disconnected',
    Status: undefined
  })
  assert.deepEqual(PollingErrorDetails(null), { Code: undefined, Detail: 'null', Status: undefined })
})

test('identifies permanent destination errors for Telegram and Discord', () => {
  assert.equal(IsPermanentDestinationError(Object.assign(new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user'), { statusCode: 403 })), true)
  assert.equal(IsPermanentDestinationError(Object.assign(new Error('ETELEGRAM: 403 Forbidden: bot was kicked from the group chat'), { statusCode: 403 })), true)
  assert.equal(IsPermanentDestinationError(Object.assign(new Error('ETELEGRAM: 400 Bad Request: chat not found'), { statusCode: 400 })), true)
  assert.equal(IsPermanentDestinationError(Object.assign(new Error('Cannot send messages to this user'), { code: 50007, status: 403 })), true)
  assert.equal(IsPermanentDestinationError(Object.assign(new Error('Unknown Channel'), { code: 10003, status: 404 })), true)
  assert.equal(IsPermanentDestinationError(new Error('Discord destination is unavailable')), true)

  assert.equal(IsPermanentDestinationError(Object.assign(new Error('Internal Server Error'), { statusCode: 500 })), false)
  assert.equal(IsPermanentDestinationError(Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' })), false)
})