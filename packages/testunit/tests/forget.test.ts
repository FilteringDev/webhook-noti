import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NotifierDatabase } from '../../../apps/notifier/source/database.js'

const Repository = { Owner: 'acme', Name: 'widget' }

test('forgets only destinations associated with a Discord guild', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    const Database = await NotifierDatabase.Open(Directory)
    Database.SaveDestination({ ExternalId: 'channel-a', GuildId: 'guild-a', IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'owner-a', Platform: 'discord', Repository, TopicId: null })
    Database.SaveDestination({ ExternalId: 'channel-b', GuildId: 'guild-b', IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'owner-b', Platform: 'discord', Repository, TopicId: null })
    Database.SaveDestination({ ExternalId: 'legacy-channel', GuildId: null, IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'owner-a', Platform: 'discord', Repository, TopicId: null })

    Database.ForgetDiscordGuild('guild-a')

    assert.deepEqual(Database.DestinationsFor(Repository, false).map((Destination) => Destination.ExternalId), ['channel-b', 'legacy-channel'])
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})

test('forgets every Telegram topic in a chat without affecting another chat', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    const Database = await NotifierDatabase.Open(Directory)
    Database.SaveDestination({ ExternalId: 'chat-a', GuildId: null, IncludePrerelease: false, Kind: 'telegram-topic', Language: 'en', OwnerId: 'owner-a', Platform: 'telegram', Repository, TopicId: 1 })
    Database.SaveDestination({ ExternalId: 'chat-a', GuildId: null, IncludePrerelease: false, Kind: 'telegram-topic', Language: 'en', OwnerId: 'owner-b', Platform: 'telegram', Repository, TopicId: 2 })
    Database.SaveDestination({ ExternalId: 'chat-b', GuildId: null, IncludePrerelease: false, Kind: 'telegram-chat', Language: 'en', OwnerId: 'owner-c', Platform: 'telegram', Repository, TopicId: null })

    Database.ForgetTelegramChat('chat-a')

    assert.deepEqual(Database.DestinationsFor(Repository, false).map((Destination) => Destination.ExternalId), ['chat-b'])
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})

test('forgets a direct-message destination and its language setting', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    const Database = await NotifierDatabase.Open(Directory)
    Database.SaveDestination({ ExternalId: 'user-a', GuildId: null, IncludePrerelease: false, Kind: 'discord-dm', Language: 'ko', OwnerId: 'user-a', Platform: 'discord', Repository, TopicId: null })
    Database.SetLanguage('discord', 'user-a', 'ko')
    Database.SaveDestination({ ExternalId: 'channel-a', GuildId: 'guild-a', IncludePrerelease: false, Kind: 'discord-channel', Language: 'en', OwnerId: 'owner-a', Platform: 'discord', Repository, TopicId: null })

    Database.ForgetDirectMessage('discord', 'user-a')

    assert.deepEqual(Database.DestinationsFor(Repository, false).map((Destination) => Destination.ExternalId), ['channel-a'])
    assert.equal(Database.LanguageFor('discord', 'user-a'), 'en')
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})