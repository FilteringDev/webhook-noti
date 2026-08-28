import type { Destination } from '@webhook-noti/core'
import type { NotifierDatabase } from './database.js'

export interface PlatformNotifier {
  send(destination: Destination, content: string): Promise<void>
}

const retry = async (operation: () => Promise<void>): Promise<void> => {
  let lastError: unknown
  for (const delay of [0, 250, 1_000] as const) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export const deliver = async (
  database: NotifierDatabase,
  notifiers: Map<Destination['platform'], PlatformNotifier>,
  destination: Destination,
  deliveryId: string,
  message: string
): Promise<void> => {
  const notifier = notifiers.get(destination.platform)
  if (notifier === undefined) {
    database.recordAttempt(destination.id, deliveryId, 'failed', 'Platform bot is disabled')
    return
  }
  try {
    await retry(() => notifier.send(destination, message))
    database.recordAttempt(destination.id, deliveryId, 'sent')
  } catch (error) {
    database.recordAttempt(destination.id, deliveryId, 'failed', error instanceof Error ? error.message : 'Unknown delivery error')
  }
}