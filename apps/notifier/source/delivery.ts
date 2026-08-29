import type { Destination } from '@webhook-noti/core'
import { consola } from 'consola'
import type { NotifierDatabase } from './database.js'

const Logger = consola.withTag('delivery')
const RetryDelaysMs = [250, 1_000] as const
const MaximumRetryAfterMs = 30_000
const TransientNetworkCodes = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EFATAL',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT'
])

export interface PlatformNotifier {
  Send(Destination: Destination, Content: string): Promise<void>
}

function ObjectValue(Value: unknown): Record<string, unknown> | undefined {
  return Value !== null && typeof Value === 'object' ? Value as Record<string, unknown> : undefined
}

function StatusCode(CaughtError: unknown): number | undefined {
  const ErrorValue = ObjectValue(CaughtError)
  const ResponseValue = ObjectValue(ErrorValue?.response)
  const Value = ErrorValue?.statusCode ?? ErrorValue?.status ?? ResponseValue?.statusCode ?? ResponseValue?.status
  return typeof Value === 'number' ? Value : undefined
}

function HeaderValue(CaughtError: unknown, Name: string): string | undefined {
  const ErrorValue = ObjectValue(CaughtError)
  const ResponseValue = ObjectValue(ErrorValue?.response)
  const Headers = ObjectValue(ErrorValue?.headers) ?? ObjectValue(ResponseValue?.headers)
  const Value = Headers?.[Name] ?? Headers?.[Name.toLowerCase()]
  return typeof Value === 'string' ? Value : Array.isArray(Value) && typeof Value[0] === 'string' ? Value[0] : undefined
}

function RetryAfterMs(CaughtError: unknown): number | undefined {
  const Value = HeaderValue(CaughtError, 'Retry-After')
  if (Value === undefined) return undefined
  const Seconds = Number(Value)
  const Delay = Number.isFinite(Seconds) ? Seconds * 1_000 : Date.parse(Value) - Date.now()
  return Number.isFinite(Delay) && Delay >= 0 && Delay <= MaximumRetryAfterMs ? Delay : undefined
}

export function IsTransientError(CaughtError: unknown): boolean {
  const ErrorValue = ObjectValue(CaughtError)
  const Code = ErrorValue?.code
  const Status = StatusCode(CaughtError)
  if (typeof Code === 'string' && TransientNetworkCodes.has(Code)) return true
  if (Status === 429 || (Status !== undefined && Status >= 500 && Status <= 599)) return true
  return CaughtError instanceof Error && /(?:TLS|socket|network|connection).*(?:closed|disconnect|reset)|timed?\s*out/i.test(CaughtError.message)
}

export async function Retry(Operation: () => Promise<void>, OnFailure: (Attempt: number, CaughtError: unknown) => void, Delays: readonly number[] = RetryDelaysMs): Promise<void> {
  let LastError: unknown
  for (let Attempt = 0; Attempt <= Delays.length; Attempt += 1) {
    try {
      await Operation()
      return
    } catch (CaughtError) {
      LastError = CaughtError
      OnFailure(Attempt + 1, CaughtError)
      if (!IsTransientError(CaughtError) || Attempt === Delays.length) throw CaughtError
      const Delay = StatusCode(CaughtError) === 429 ? RetryAfterMs(CaughtError) : undefined
      if (StatusCode(CaughtError) === 429 && Delay === undefined && HeaderValue(CaughtError, 'Retry-After') !== undefined) throw CaughtError
      await new Promise<void>((Resolve) => setTimeout(Resolve, Delay ?? Delays[Attempt]))
    }
  }
  throw LastError
}

export async function Deliver(
  Database: NotifierDatabase,
  Notifiers: Map<Destination['Platform'], PlatformNotifier>,
  Destination: Destination,
  ReleaseKey: string,
  Message: string
): Promise<void> {
  function Record(Status: 'sent' | 'failed', ErrorMessage?: string): void {
    if (Database.HasDestination(Destination.Id)) Database.RecordAttempt(Destination.Id, ReleaseKey, Status, ErrorMessage)
  }
  const Notifier = Notifiers.get(Destination.Platform)
  if (Notifier === undefined) {
    Record('failed', 'Platform bot is disabled')
    Logger.error({ message: 'Delivery failed: platform bot is disabled', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform })
    return
  }
  try {
    await Retry(
      () => Notifier.Send(Destination, Message),
      (Attempt, CaughtError) => Logger.warn({ message: 'Delivery attempt failed', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform, Attempt, Error: CaughtError })
    )
    Record('sent')
    Logger.info({ message: 'Delivery sent', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform })
  } catch (CaughtError) {
    Record('failed', CaughtError instanceof Error ? CaughtError.message : 'Unknown delivery error')
    Logger.error({ message: 'Delivery failed after retries', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform, Error: CaughtError })
  }
}
