import { randomUUID } from 'node:crypto'
import type { Repository } from '@webhook-noti/core'

export type RepositoryAction = 'subscribe' | 'unsubscribe' | 'dm-enable' | 'dm-disable'

export interface SelectionContext {
  Action: RepositoryAction
  ExternalId: string
  IncludePrerelease: boolean
  OwnerId: string
  SourceId: string
  TopicId: number | null
}

type SelectionValidationContext = Pick<SelectionContext, 'OwnerId' | 'SourceId' | 'TopicId'>

export interface SelectionPage {
  Id: string
  Page: number
  PageCount: number
  Repositories: Repository[]
}

interface Selection extends SelectionContext {
  ExpiresAt: number
  Page: number
}

const PageSize = 20
const LifetimeMilliseconds = 10 * 60 * 1_000

export class RepositorySelector {
  readonly #Repositories: Repository[]
  readonly #Selections = new Map<string, Selection>()

  constructor(Repositories: Repository[]) {
    this.#Repositories = [...Repositories].sort((Left, Right) => `${Left.Owner}/${Left.Name}`.localeCompare(`${Right.Owner}/${Right.Name}`))
  }

  Create(Context: SelectionContext): SelectionPage {
    this.#RemoveExpired()
    const Id = randomUUID()
    this.#Selections.set(Id, { ...Context, ExpiresAt: Date.now() + LifetimeMilliseconds, Page: 0 })
    return this.#Page(Id)
  }

  Previous(Id: string, Context: SelectionValidationContext): SelectionPage | null {
    const Selection = this.#Selection(Id, Context)
    if (Selection === null) return null
    Selection.Page = Math.max(0, Selection.Page - 1)
    return this.#Page(Id)
  }

  Next(Id: string, Context: SelectionValidationContext): SelectionPage | null {
    const Selection = this.#Selection(Id, Context)
    if (Selection === null) return null
    Selection.Page = Math.min(this.#PageCount() - 1, Selection.Page + 1)
    return this.#Page(Id)
  }

  Select(Id: string, Context: SelectionValidationContext, Index: string): { Action: RepositoryAction, ExternalId: string, IncludePrerelease: boolean, Repository: Repository, TopicId: number | null } | null {
    const Selection = this.#Selection(Id, Context)
    if (Selection === null || !/^(?:0|[1-9][0-9]*)$/.test(Index)) return null
    const PageIndex = Number(Index)
    if (PageIndex >= PageSize) return null
    const Repository = this.#Repositories[Selection.Page * PageSize + PageIndex]
    if (Repository === undefined) return null
    this.#Selections.delete(Id)
    return { Action: Selection.Action, ExternalId: Selection.ExternalId, IncludePrerelease: Selection.IncludePrerelease, Repository, TopicId: Selection.TopicId }
  }

  #Selection(Id: string, Context: SelectionValidationContext): Selection | null {
    this.#RemoveExpired()
    const Selection = this.#Selections.get(Id)
    if (Selection === undefined || Selection.OwnerId !== Context.OwnerId || Selection.SourceId !== Context.SourceId || Selection.TopicId !== Context.TopicId) return null
    return Selection
  }

  #Page(Id: string): SelectionPage {
    const Selection = this.#Selections.get(Id)
    if (Selection === undefined) throw new Error('Selection does not exist')
    const Start = Selection.Page * PageSize
    return { Id, Page: Selection.Page, PageCount: this.#PageCount(), Repositories: this.#Repositories.slice(Start, Start + PageSize) }
  }

  #PageCount(): number {
    return Math.ceil(this.#Repositories.length / PageSize)
  }

  #RemoveExpired(): void {
    const Now = Date.now()
    for (const [Id, Selection] of this.#Selections) {
      if (Selection.ExpiresAt <= Now) this.#Selections.delete(Id)
    }
  }
}