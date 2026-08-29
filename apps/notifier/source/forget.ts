import { randomUUID } from 'node:crypto'

export type ForgetScope =
  | { Platform: 'discord', Type: 'guild', GuildId: string }
  | { Platform: 'discord', Type: 'dm', ExternalId: string }
  | { Platform: 'telegram', Type: 'chat' | 'dm', ExternalId: string }

interface Confirmation {
  ExpiresAt: number
  OwnerId: string
  Scope: ForgetScope
  SourceId: string
}

const LifetimeMilliseconds = 5 * 60 * 1_000

export class ForgetConfirmation {
  readonly #Confirmations = new Map<string, Confirmation>()

  Create(OwnerId: string, SourceId: string, Scope: ForgetScope): string {
    this.#RemoveExpired()
    const Id = randomUUID()
    this.#Confirmations.set(Id, { ExpiresAt: Date.now() + LifetimeMilliseconds, OwnerId, Scope, SourceId })
    return Id
  }

  Take(Id: string, OwnerId: string, SourceId: string): ForgetScope | null {
    this.#RemoveExpired()
    const Confirmation = this.#Confirmations.get(Id)
    if (Confirmation === undefined || Confirmation.OwnerId !== OwnerId || Confirmation.SourceId !== SourceId) return null
    this.#Confirmations.delete(Id)
    return Confirmation.Scope
  }

  #RemoveExpired(): void {
    const Now = Date.now()
    for (const [Id, Confirmation] of this.#Confirmations) {
      if (Confirmation.ExpiresAt <= Now) this.#Confirmations.delete(Id)
    }
  }
}