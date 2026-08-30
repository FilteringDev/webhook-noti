import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NotifierDatabase } from '../../../apps/notifier/source/database.js'
import { GetEnvironment } from '../../../apps/notifier/source/env.js'
import { RepositorySelector } from '../../../apps/notifier/source/selection.js'

const SensitiveNames = ['GITHUB_APP_PRIVATE_KEY', 'GLOBALPING_API_TOKEN', 'DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'] as const

test('loads sensitive settings only from non-empty files', () => {
  const Original = new Map<string, string | undefined>([
    ['GITHUB_APP_ID', process.env.GITHUB_APP_ID],
    ...SensitiveNames.flatMap((Name) => [[Name, process.env[Name]], [`${Name}_FILE`, process.env[`${Name}_FILE`]]] as const)
  ])
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    for (const Name of SensitiveNames) {
      delete process.env[Name]
      delete process.env[`${Name}_FILE`]
    }
    delete process.env.GITHUB_APP_ID
    process.env.GITHUB_APP_PRIVATE_KEY = 'plaintext-is-not-accepted'
    process.env.GLOBALPING_API_TOKEN = 'plaintext-is-not-accepted'
    assert.throws(GetEnvironment, /GITHUB_APP_ID is required/)

    const GithubAppPrivateKeyPath = join(Directory, 'github-app-private-key')
    const GlobalpingApiTokenPath = join(Directory, 'globalping-api-token')
    const DiscordTokenPath = join(Directory, 'discord-token')
    writeFileSync(GithubAppPrivateKeyPath, 'github-app-private-key\n')
    writeFileSync(GlobalpingApiTokenPath, 'globalping-api-token\n')
    writeFileSync(DiscordTokenPath, '')
    process.env.GITHUB_APP_ID = '12345'
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = GithubAppPrivateKeyPath
    process.env.GLOBALPING_API_TOKEN_FILE = GlobalpingApiTokenPath
    process.env.DISCORD_BOT_TOKEN_FILE = DiscordTokenPath

    const Environment = GetEnvironment()
    assert.equal(Environment.GithubAppId, '12345')
    assert.equal(Environment.GithubAppPrivateKey, 'github-app-private-key')
    assert.equal(Environment.GlobalpingApiToken, 'globalping-api-token')
    assert.equal(Environment.DiscordToken, undefined)
  } finally {
    for (const [Name, Value] of Original) {
      if (Value === undefined) delete process.env[Name]
      else process.env[Name] = Value
    }
    rmSync(Directory, { force: true, recursive: true })
  }
})

test('selects only installed repositories and rejects mismatched callbacks', () => {
  const Repositories = Array.from({ length: 21 }).map((UnusedValue, Index) => {
    void UnusedValue
    return { Owner: 'acme', Name: `repository-${Index}` }
  })
  const Selector = new RepositorySelector(() => Repositories)
  const Context = { Action: 'subscribe' as const, ExternalId: 'destination', IncludePrerelease: false, OwnerId: 'owner', SourceId: 'source', TopicId: null }
  const FirstPage = Selector.Create(Context)
  assert.equal(FirstPage.Repositories.length, 20)
  assert.equal(FirstPage.PageCount, 2)
  assert.equal(Selector.Select(FirstPage.Id, { ...Context, OwnerId: 'other-user' }, '0'), null)
  assert.equal(Selector.Select(FirstPage.Id, { ...Context, SourceId: 'other-source' }, '0'), null)
  assert.equal(Selector.Select(FirstPage.Id, Context, '20'), null)

  const SecondPage = Selector.Next(FirstPage.Id, Context)
  assert.ok(SecondPage !== null)
  assert.equal(SecondPage.Repositories[0]?.Name, 'repository-9')
  const Selected = Selector.Select(FirstPage.Id, Context, '0')
  assert.deepEqual(Selected, { Action: 'subscribe', ExternalId: 'destination', IncludePrerelease: false, Repository: { Owner: 'acme', Name: 'repository-9' }, TopicId: null })
  assert.equal(Selector.Select(FirstPage.Id, Context, '0'), null)
})

test('stores repository-specific channel and topic routes', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  const RepositoryA = { Owner: 'acme', Name: 'api' }
  const RepositoryB = { Owner: 'acme', Name: 'worker' }
  try {
    const Database = await NotifierDatabase.Open(Directory)
    Database.SaveDestination({ ExternalId: 'discord-channel-a', GuildId: null, IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'discord-owner', Platform: 'discord', Repository: RepositoryA, TopicId: null })
    Database.SaveDestination({ ExternalId: 'discord-channel-b', GuildId: null, IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'discord-owner', Platform: 'discord', Repository: RepositoryB, TopicId: null })
    Database.SaveDestination({ ExternalId: 'telegram-chat', GuildId: null, IncludePrerelease: false, Kind: 'telegram-topic', Language: 'ko', OwnerId: 'telegram-owner', Platform: 'telegram', Repository: RepositoryA, TopicId: 123 })

    const RepositoryADestinations = Database.DestinationsFor(RepositoryA, false)
    assert.equal(RepositoryADestinations.length, 2)
    assert.equal(RepositoryADestinations.some((Destination) => Destination.Platform === 'discord' && Destination.ExternalId === 'discord-channel-a'), true)
    assert.equal(RepositoryADestinations.some((Destination) => Destination.Platform === 'telegram' && Destination.ExternalId === 'telegram-chat' && Destination.TopicId === 123), true)

    const RepositoryBDestinations = Database.DestinationsFor(RepositoryB, false)
    assert.equal(RepositoryBDestinations.length, 1)
    assert.equal(RepositoryBDestinations[0]?.ExternalId, 'discord-channel-b')
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})

test('summarizes active destinations and identifies first activations', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  const RepositoryA = { Owner: 'acme', Name: 'api' }
  const RepositoryB = { Owner: 'acme', Name: 'worker' }
  try {
    const Database = await NotifierDatabase.Open(Directory)
    assert.deepEqual(Database.ActiveDestinationSummary(), { DiscordServers: 0, DiscordUsers: 0, TelegramChats: 0, TelegramUsers: 0 })

    assert.equal(Database.SaveDestination({ ExternalId: 'discord-channel-a', GuildId: 'discord-guild', IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'discord-owner', Platform: 'discord', Repository: RepositoryA, TopicId: null }), 'discord-server')
    assert.equal(Database.SaveDestination({ ExternalId: 'discord-channel-b', GuildId: 'discord-guild', IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'discord-owner', Platform: 'discord', Repository: RepositoryB, TopicId: null }), undefined)
    assert.equal(Database.SaveDestination({ ExternalId: 'discord-user', GuildId: null, IncludePrerelease: false, Kind: 'discord-dm', Language: 'en', OwnerId: 'discord-user', Platform: 'discord', Repository: RepositoryA, TopicId: null }), 'discord-user')
    assert.equal(Database.SaveDestination({ ExternalId: 'telegram-chat', GuildId: null, IncludePrerelease: false, Kind: 'telegram-chat', Language: 'en', OwnerId: 'telegram-owner', Platform: 'telegram', Repository: RepositoryA, TopicId: null }), 'telegram-chat')
    assert.equal(Database.SaveDestination({ ExternalId: 'telegram-chat', GuildId: null, IncludePrerelease: false, Kind: 'telegram-topic', Language: 'en', OwnerId: 'telegram-owner', Platform: 'telegram', Repository: RepositoryB, TopicId: 123 }), undefined)
    assert.equal(Database.SaveDestination({ ExternalId: 'telegram-user', GuildId: null, IncludePrerelease: false, Kind: 'telegram-dm', Language: 'en', OwnerId: 'telegram-user', Platform: 'telegram', Repository: RepositoryA, TopicId: null }), 'telegram-user')

    assert.deepEqual(Database.ActiveDestinationSummary(), { DiscordServers: 1, DiscordUsers: 1, TelegramChats: 1, TelegramUsers: 1 })
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})

test('lists only scoped non-DM subscription routes', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    const Database = await NotifierDatabase.Open(Directory)
    Database.SaveDestination({ ExternalId: 'discord-channel-a', GuildId: null, IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'discord-owner', Platform: 'discord', Repository: { Owner: 'acme', Name: 'api' }, TopicId: null })
    Database.SaveDestination({ ExternalId: 'discord-channel-b', GuildId: null, IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'discord-owner', Platform: 'discord', Repository: { Owner: 'acme', Name: 'worker' }, TopicId: null })
    Database.SaveDestination({ ExternalId: 'discord-user', GuildId: null, IncludePrerelease: false, Kind: 'discord-dm', Language: 'en', OwnerId: 'discord-owner', Platform: 'discord', Repository: { Owner: 'acme', Name: 'dm-only' }, TopicId: null })
    Database.SaveDestination({ ExternalId: 'telegram-chat', GuildId: null, IncludePrerelease: false, Kind: 'telegram-topic', Language: 'ko', OwnerId: 'telegram-owner', Platform: 'telegram', Repository: { Owner: 'acme', Name: 'api' }, TopicId: 123 })

    assert.deepEqual(Database.RoutesFor('discord', ['discord-channel-a']), [{
      Id: 1,
      Platform: 'discord',
      Kind: 'discord-channel',
      ExternalId: 'discord-channel-a',
      TopicId: null,
      OwnerId: 'discord-owner',
      Language: 'en',
      DirectMessage: false,
      IncludePrerelease: false,
      Repository: { Owner: 'acme', Name: 'api' }
    }])
    assert.equal(Database.RoutesFor('discord', []).length, 0)
    assert.deepEqual(Database.RoutesFor('telegram', ['telegram-chat']).map((Route) => ({ Repository: Route.Repository, TopicId: Route.TopicId })), [{ Repository: { Owner: 'acme', Name: 'api' }, TopicId: 123 }])
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})
