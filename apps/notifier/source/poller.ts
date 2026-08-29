import { RepositorySlug, type Release, type Repository } from '@webhook-noti/core'
import { consola } from 'consola'
import type { NotifierDatabase } from './database.js'
import type { ReleasePage } from './github.js'

const Logger = consola.withTag('poller')
const DefaultIntervalMilliseconds = 60_000

export interface PolledRelease {
  Id: number
  PublishedAt: string
  Value: Release
}

export interface ReleaseSource {
  ListReleases(RepositoryValue: Repository, ETag?: string): Promise<ReleasePage>
}

export interface RepositorySource {
  List(): Repository[]
}

export interface ReleasePollerOptions {
  Database: NotifierDatabase
  Github: ReleaseSource
  IntervalMilliseconds?: number
  OnRelease: (ReleaseValue: Release, ReleaseKey: string) => void
  Repositories: RepositorySource
}

export interface ReleasePoller {
  Poll(): Promise<void>
  Start(): void
  Stop(): void
}

// Mirrors the GitHub releases REST payload, whose keys are fixed by GitHub's API.
/* oxlint-disable crackle/pascal-case */
export function ReleaseFrom(RepositoryValue: Repository, Payload: unknown): PolledRelease | null {
  if (typeof Payload !== 'object' || Payload === null) return null
  const Value = Payload as { id?: unknown, tag_name?: unknown, name?: unknown, body?: unknown, author?: { login?: unknown } | null, html_url?: unknown, prerelease?: unknown, draft?: unknown, target_commitish?: unknown, published_at?: unknown }
  if (typeof Value.id !== 'number' || Value.draft === true) return null
  if (typeof Value.tag_name !== 'string' || typeof Value.html_url !== 'string' || typeof Value.target_commitish !== 'string' || typeof Value.published_at !== 'string') return null
  return {
    Id: Value.id,
    PublishedAt: Value.published_at,
    Value: {
      Repository: RepositoryValue,
      Title: typeof Value.name === 'string' && Value.name.length > 0 ? Value.name : Value.tag_name,
      Tag: Value.tag_name,
      Body: typeof Value.body === 'string' ? Value.body : '',
      Author: typeof Value.author?.login === 'string' ? Value.author.login : 'github',
      Url: Value.html_url,
      IsPrerelease: Value.prerelease === true,
      TargetCommitish: Value.target_commitish
    }
  }
}
/* oxlint-enable crackle/pascal-case */

export function CreateReleasePoller(Options: ReleasePollerOptions): ReleasePoller {
  const IntervalMilliseconds = Options.IntervalMilliseconds ?? DefaultIntervalMilliseconds
  let Running = false
  let Timer: NodeJS.Timeout | undefined

  async function PollRepository(RepositoryValue: Repository): Promise<void> {
    const Slug = RepositorySlug(RepositoryValue)
    const Watermark = Options.Database.Watermark(Slug)
    const Page = await Options.Github.ListReleases(RepositoryValue, Watermark?.ETag)
    if (Page.NotModified) return
    const Releases = Page.Releases
      .flatMap((Payload) => {
        const Parsed = ReleaseFrom(RepositoryValue, Payload)
        return Parsed === null ? [] : [Parsed]
      })
      .sort((Left, Right) => Left.PublishedAt.localeCompare(Right.PublishedAt))
    const Latest = Releases.at(-1)?.PublishedAt

    if (Watermark === undefined) {
      // Cold start: adopt the current state as the baseline so historical releases are never announced.
      for (const Item of Releases) Options.Database.RecordRelease(Slug, Item.Id)
      Options.Database.SaveWatermark(Slug, Latest ?? new Date().toISOString(), Page.ETag)
      Logger.info({ message: 'Release baseline recorded', Repository: Slug, ReleaseCount: Releases.length })
      return
    }

    for (const Item of Releases) {
      if (Item.PublishedAt <= Watermark.PublishedAt) continue
      if (!Options.Database.RecordRelease(Slug, Item.Id)) continue
      const ReleaseKey = `${Slug}#${Item.Id}`
      Logger.info({ message: 'Release detected', Repository: Slug, ReleaseKey, Tag: Item.Value.Tag, IsPrerelease: Item.Value.IsPrerelease })
      Options.OnRelease(Item.Value, ReleaseKey)
    }
    Options.Database.SaveWatermark(Slug, Latest === undefined || Latest < Watermark.PublishedAt ? Watermark.PublishedAt : Latest, Page.ETag)
  }

  async function Poll(): Promise<void> {
    if (Running) return
    Running = true
    try {
      for (const RepositoryValue of Options.Repositories.List()) {
        try {
          await PollRepository(RepositoryValue)
        } catch (CaughtError) {
          Logger.error({ message: 'Release polling failed', Repository: RepositorySlug(RepositoryValue), Error: CaughtError })
        }
      }
    } finally {
      Running = false
    }
  }

  return {
    Poll,
    Start(): void {
      void Poll()
      Timer = setInterval(() => {
        void Poll()
      }, IntervalMilliseconds)
      Timer.unref()
    },
    Stop(): void {
      if (Timer !== undefined) clearInterval(Timer)
      Timer = undefined
    }
  }
}
