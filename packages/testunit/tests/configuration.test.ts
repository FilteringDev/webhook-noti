import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GetEnvironment } from '../../../apps/notifier/source/env.js'
import { RepositorySelector } from '../../../apps/notifier/source/selection.js'

const SensitiveNames = ['GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'] as const

test('loads sensitive settings only from non-empty files', () => {
  const Original = new Map<string, string | undefined>([
    ['ALLOWED_REPOSITORIES', process.env.ALLOWED_REPOSITORIES],
    ...SensitiveNames.flatMap((Name) => [[Name, process.env[Name]], [`${Name}_FILE`, process.env[`${Name}_FILE`]]] as const)
  ])
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    for (const Name of SensitiveNames) {
      delete process.env[Name]
      delete process.env[`${Name}_FILE`]
    }
    process.env.ALLOWED_REPOSITORIES = 'Acme/Widget,acme/API'
    process.env.GITHUB_TOKEN = 'plaintext-is-not-accepted'
    process.env.GITHUB_WEBHOOK_SECRET = 'plaintext-is-not-accepted'
    assert.throws(GetEnvironment, /GITHUB_TOKEN_FILE is required/)

    const GithubTokenPath = join(Directory, 'github-token')
    const WebhookSecretPath = join(Directory, 'webhook-secret')
    const DiscordTokenPath = join(Directory, 'discord-token')
    writeFileSync(GithubTokenPath, 'github-token\n')
    writeFileSync(WebhookSecretPath, 'webhook-secret\n')
    writeFileSync(DiscordTokenPath, '')
    process.env.GITHUB_TOKEN_FILE = GithubTokenPath
    process.env.GITHUB_WEBHOOK_SECRET_FILE = WebhookSecretPath
    process.env.DISCORD_BOT_TOKEN_FILE = DiscordTokenPath

    const Environment = GetEnvironment()
    assert.equal(Environment.GithubToken, 'github-token')
    assert.equal(Environment.GithubWebhookSecret, 'webhook-secret')
    assert.equal(Environment.DiscordToken, undefined)
    assert.deepEqual(Environment.Repositories, [{ Owner: 'acme', Name: 'widget' }, { Owner: 'acme', Name: 'api' }])
  } finally {
    for (const [Name, Value] of Original) {
      if (Value === undefined) delete process.env[Name]
      else process.env[Name] = Value
    }
    rmSync(Directory, { force: true, recursive: true })
  }
})

test('selects only configured repositories and rejects mismatched callbacks', () => {
  const Repositories = Array.from({ length: 21 }).map((UnusedValue, Index) => {
    void UnusedValue
    return { Owner: 'acme', Name: `repository-${Index}` }
  })
  const Selector = new RepositorySelector(Repositories)
  const Context = { Action: 'subscribe' as const, ExternalId: 'destination', IncludePrerelease: false, OwnerId: 'owner', TopicId: null }
  const FirstPage = Selector.Create(Context)
  assert.equal(FirstPage.Repositories.length, 20)
  assert.equal(FirstPage.PageCount, 2)
  assert.equal(Selector.Select(FirstPage.Id, { ...Context, OwnerId: 'other-user' }, '0'), null)
  assert.equal(Selector.Select(FirstPage.Id, Context, '20'), null)

  const SecondPage = Selector.Next(FirstPage.Id, Context)
  assert.ok(SecondPage !== null)
  assert.equal(SecondPage.Repositories[0]?.Name, 'repository-9')
  const Selected = Selector.Select(FirstPage.Id, Context, '0')
  assert.deepEqual(Selected, { Action: 'subscribe', IncludePrerelease: false, Repository: { Owner: 'acme', Name: 'repository-9' } })
  assert.equal(Selector.Select(FirstPage.Id, Context, '0'), null)
})