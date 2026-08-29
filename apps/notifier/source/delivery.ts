import type { Destination } from '@webhook-noti/core'
import type { NotifierDatabase } from './database.js'

export interface PlatformNotifier {
  Send(Destination: Destination, Content: string): Promise<void>
}

async function Retry(Operation: () => Promise<void>): Promise<void> {
  let LastError: unknown
  for (const Delay of [0, 250, 1_000] as const) {
    if (Delay > 0) await new Promise<void>((Resolve) => setTimeout(Resolve, Delay))
    try {
      await Operation()
      return
    } catch (CaughtError) {
      LastError = CaughtError
    }
  }
  throw LastError
}

export async function Deliver(
  Database: NotifierDatabase,
  Notifiers: Map<Destination['Platform'], PlatformNotifier>,
  Destination: Destination,
  DeliveryId: string,
  Message: string
): Promise<void> {
  function Record(Status: 'sent' | 'failed', ErrorMessage?: string): void {
    if (Database.HasDestination(Destination.Id)) Database.RecordAttempt(Destination.Id, DeliveryId, Status, ErrorMessage)
  }
  const Notifier = Notifiers.get(Destination.Platform)
  if (Notifier === undefined) {
    Record('failed', 'Platform bot is disabled')
    return
  }
  try {
    await Retry(() => Notifier.Send(Destination, Message))
    Record('sent')
  } catch (CaughtError) {
    Record('failed', CaughtError instanceof Error ? CaughtError.message : 'Unknown delivery error')
  }
}
