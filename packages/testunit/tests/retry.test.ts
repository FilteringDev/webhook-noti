import assert from 'node:assert/strict'
import test from 'node:test'
import { RunGuarded } from '../../../apps/notifier/source/async-guard.js'
import { IsTransientError, Retry } from '../../../apps/notifier/source/delivery.js'

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