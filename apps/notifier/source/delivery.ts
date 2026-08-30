import type { Destination } from '@webhook-noti/core'
import type { NotifierDatabase } from './database.js'
import { Logger as RootLogger } from './logging.js'

const Logger = RootLogger.withTag('delivery')
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

export function IsPermanentDestinationError(CaughtError: unknown): boolean {
  const Status = StatusCode(CaughtError)
  if (Status === 403 || Status === 404) return true

  const ErrorValue = ObjectValue(CaughtError)
  const Code = ErrorValue?.code
  if (typeof Code === 'number' && [50007, 10003, 10013, 50001, 50013].includes(Code)) return true

  const RawMessage = ErrorValue?.message
  const MessageText = CaughtError instanceof Error ? CaughtError.message : typeof RawMessage === 'string' ? RawMessage : ''
  if (/Discord destination is unavailable/i.test(MessageText)) return true
  if (/(?:bot was (?:blocked|kicked)|chat not found|group chat was upgraded|user is deactivated|chat write access denied|peer id invalid|cannot send messages to this user|unknown channel|unknown user|missing access|missing permissions)/i.test(MessageText)) return true

  return false
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
    Logger.error({ message: 'Delivery failed: platform bot is disabled', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform, Kind: Destination.Kind })
    return
  }
  try {
    Logger.info({ message: 'Delivery send started', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform, Kind: Destination.Kind })
    await Retry(
      () => Notifier.Send(Destination, Message),
      (Attempt, CaughtError) => Logger.warn({ message: 'Delivery attempt failed', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform, Kind: Destination.Kind, Attempt, Error: CaughtError, IsTransient: IsTransientError(CaughtError), StatusCode: StatusCode(CaughtError) })
    )
    Record('sent')
    Logger.info({ message: 'Delivery sent', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform, Kind: Destination.Kind })
  } catch (CaughtError) {
    Record('failed', CaughtError instanceof Error ? CaughtError.message : 'Unknown delivery error')
    Logger.error({ message: 'Delivery failed after retries', ReleaseKey, DestinationId: Destination.Id, Platform: Destination.Platform, Kind: Destination.Kind, Error: CaughtError })
    if (IsPermanentDestinationError(CaughtError)) {
      Database.ForgetDestination(Destination)
      Logger.info({ message: 'Automatically removed unreachable destination', DestinationId: Destination.Id, Platform: Destination.Platform, ExternalId: Destination.ExternalId, Kind: Destination.Kind })
    }
  }
}
