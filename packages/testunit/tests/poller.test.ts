import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Release, Repository } from '@webhook-noti/core'
import { NotifierDatabase } from '../../../apps/notifier/source/database.js'
import type { ReleasePage } from '../../../apps/notifier/source/github.js'
import { CreateReleasePoller } from '../../../apps/notifier/source/poller.js'

const RepositoryValue: Repository = { Owner: 'acme', Name: 'widget' }

/* oxlint-disable crackle/pascal-case */
function GithubRelease(Id: number, PublishedAt: string, Extra: Record<string, unknown> = {}): unknown {
  return {
    id: Id,
    tag_name: `v${Id}`,
    name: `Release ${Id}`,
    body: 'notes',
    author: { login: 'octocat' },
    html_url: `https://github.com/acme/widget/releases/tag/v${Id}`,
    prerelease: false,
    draft: false,
    target_commitish: 'main',
    published_at: PublishedAt,
    ...Extra
  }
}
/* oxlint-enable crackle/pascal-case */

function CreatePoller(Database: NotifierDatabase, Pages: ReleasePage[], Delivered: string[]): { Poll: () => Promise<void>, Requests: (string | undefined)[] } {
  const Requests: (string | undefined)[] = []
  const Poller = CreateReleasePoller({
    Database,
    Github: {
      ListReleases: (UnusedRepository: Repository, ETag?: string): Promise<ReleasePage> => {
        void UnusedRepository
        Requests.push(ETag)
        return Promise.resolve(Pages.shift() ?? { NotModified: true, ETag, Releases: [] })
      }
    },
    OnRelease: (UnusedRelease: Release, ReleaseKey: string) => {
      void UnusedRelease
      Delivered.push(ReleaseKey)
    },
    Repositories: { List: () => [RepositoryValue] }
  })
  return { Poll: async () => Poller.Poll(), Requests }
}

test('records a baseline on the first poll and announces only newer releases afterwards', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    const Database = await NotifierDatabase.Open(Directory)
    const Delivered: string[] = []
    const { Poll, Requests } = CreatePoller(Database, [
      { NotModified: false, ETag: 'first', Releases: [GithubRelease(1, '2026-08-01T00:00:00Z'), GithubRelease(2, '2026-08-02T00:00:00Z')] },
      { NotModified: false, ETag: 'second', Releases: [GithubRelease(3, '2026-08-03T00:00:00Z'), GithubRelease(2, '2026-08-02T00:00:00Z')] },
      { NotModified: false, ETag: 'second', Releases: [GithubRelease(3, '2026-08-03T00:00:00Z')] }
    ], Delivered)

    await Poll()
    assert.deepEqual(Delivered, [])
    assert.deepEqual(Database.Watermark('acme/widget'), { ETag: 'first', PublishedAt: '2026-08-02T00:00:00Z' })

    await Poll()
    assert.deepEqual(Delivered, ['acme/widget#3'])

    // A repeated listing must not deliver the same release twice.
    await Poll()
    assert.deepEqual(Delivered, ['acme/widget#3'])
    assert.deepEqual(Requests, [undefined, 'first', 'second'])
    Database.Close()
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})

test('skips unmodified listings and ignores drafts', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    const Database = await NotifierDatabase.Open(Directory)
    Database.SaveWatermark('acme/widget', '2026-08-01T00:00:00Z', 'cached')
    const Delivered: string[] = []
    const { Poll, Requests } = CreatePoller(Database, [
      { NotModified: true, ETag: 'cached', Releases: [] },
      { NotModified: false, ETag: 'next', Releases: [GithubRelease(9, '2026-08-05T00:00:00Z', { draft: true })] }
    ], Delivered)

    await Poll()
    assert.deepEqual(Delivered, [])
    assert.equal(Database.Watermark('acme/widget')?.ETag, 'cached')

    await Poll()
    assert.deepEqual(Delivered, [])
    assert.deepEqual(Requests, ['cached', 'cached'])
    Database.Close()
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})
