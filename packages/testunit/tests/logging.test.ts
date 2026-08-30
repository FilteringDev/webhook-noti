import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { test } from 'vitest'
import { CreateJsonLogger } from '../../../apps/notifier/source/logging.js'

function CaptureOutput(Chunks: string[]): Writable {
  return new Writable({
    write(Chunk, UnusedEncoding, Callback) {
      void UnusedEncoding
      Chunks.push(String(Chunk))
      Callback()
    }
  })
}

function ParseLine(Line: string): Record<string, unknown> {
  assert.equal(Line.endsWith('\n'), true)
  return JSON.parse(Line) as Record<string, unknown>
}

test('serializes structured application logs as one JSON object per line', () => {
  const Chunks: string[] = []
  const Logger = CreateJsonLogger(CaptureOutput(Chunks)).withTag('delivery')

  Logger.info({ message: 'Delivery sent', ReleaseKey: 'owner/repository#42', DestinationId: 7 })

  assert.equal(Chunks.length, 1)
  const RecordValue = ParseLine(Chunks[0] ?? '')
  assert.deepEqual(Object.keys(RecordValue).sort(), ['context', 'level', 'message', 'tag', 'timestamp'])
  assert.equal(RecordValue.level, 'info')
  assert.equal(RecordValue.tag, 'delivery')
  assert.equal(RecordValue.message, 'Delivery sent')
  assert.equal(Number.isNaN(Date.parse(RecordValue.timestamp as string)), false)
  assert.deepEqual(RecordValue.context, { ReleaseKey: 'owner/repository#42', DestinationId: 7 })
})

test('preserves error diagnostics while redacting sensitive values', () => {
  const Chunks: string[] = []
  const Logger = CreateJsonLogger(CaptureOutput(Chunks)).withTag('notifier')
  const Failure = Object.assign(new Error('delivery failed', { cause: new Error('root failure') }), {
    Authorization: 'Bearer secret',
    Code: 'EFAIL',
    Details: { api_token: 'secret', Safe: 'visible' }
  })
  const Circular: Record<string, unknown> = {}
  Circular.Self = Circular

  Logger.error({ message: 'Release processing failed', Error: Failure, Circular, Count: 2n, Cookie: 'session=secret' })

  const RecordValue = ParseLine(Chunks[0] ?? '')
  const Context = RecordValue.context as Record<string, unknown>
  const ErrorValue = Context.Error as Record<string, unknown>
  const Cause = ErrorValue.cause as Record<string, unknown>
  const Details = ErrorValue.Details as Record<string, unknown>
  assert.equal(ErrorValue.name, 'Error')
  assert.equal(ErrorValue.message, 'delivery failed')
  assert.equal(typeof ErrorValue.stack, 'string')
  assert.equal(Cause.message, 'root failure')
  assert.equal(ErrorValue.Authorization, '[REDACTED]')
  assert.equal(ErrorValue.Code, 'EFAIL')
  assert.deepEqual(Details, { api_token: '[REDACTED]', Safe: 'visible' })
  assert.deepEqual(Context.Circular, { Self: '[Circular]' })
  assert.equal(Context.Count, '2')
  assert.equal(Context.Cookie, '[REDACTED]')
})

test('queues log lines in emission order while stdout is backpressured', async () => {
  const Chunks: string[] = []
  const Releases: Array<() => void> = []
  const Output = new Writable({
    highWaterMark: 1,
    write(Chunk, UnusedEncoding, Callback) {
      void UnusedEncoding
      Chunks.push(String(Chunk))
      Releases.push(Callback)
    }
  })
  const Logger = CreateJsonLogger(Output).withTag('ordered')

  Logger.info({ message: 'first' })
  Logger.warn({ message: 'second' })
  Logger.error({ message: 'third' })
  assert.equal(Chunks.length, 1)

  for (let ExpectedLength = 2; ExpectedLength <= 3; ExpectedLength += 1) {
    const Release = Releases.shift()
    assert.notEqual(Release, undefined)
    Release?.()
    await new Promise<void>((Resolve) => setImmediate(Resolve))
    assert.equal(Chunks.length, ExpectedLength)
  }
  Releases.shift()?.()

  assert.deepEqual(Chunks.map((Line) => ParseLine(Line).message), ['first', 'second', 'third'])
  assert.deepEqual(Chunks.map((Line) => ParseLine(Line).level), ['info', 'warn', 'error'])
})

test('does not collapse repeated log records', () => {
  const Chunks: string[] = []
  const Logger = CreateJsonLogger(CaptureOutput(Chunks)).withTag('repeated')

  for (let Index = 0; Index < 7; Index += 1) Logger.info({ message: 'same message' })

  assert.equal(Chunks.length, 7)
})
