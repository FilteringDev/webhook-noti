import type { Destination } from '@webhook-noti/core'
import { consola } from 'consola'
import type { NotifierDatabase } from './database.js'

const Logger = consola.withTag('delivery')

export interface PlatformNotifier {
  Send(Destination: Destination, Content: string): Promise<void>
}

async function Retry(Operation: () => Promise<void>, OnFailure: (Attempt: number, CaughtError: unknown) => void): Promise<void> {
  let LastError: unknown
  for (const [AttemptIndex, Delay] of [0, 250, 1_000].entries()) {
    if (Delay > 0) await new Promise<void>((Resolve) => setTimeout(Resolve, Delay))
    try {
      await Operation()
      return
    } catch (CaughtError) {
      LastError = CaughtError
      OnFailure(AttemptIndex + 1, CaughtError)
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
