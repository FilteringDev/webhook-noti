import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Destination } from '@webhook-noti/core'
import { NotifierDatabase } from '../../../apps/notifier/source/database.js'
import { Deliver, type PlatformNotifier } from '../../../apps/notifier/source/delivery.js'

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

test('automatically removes unreachable destination when delivery encounters permanent error', async () => {
  const Directory = mkdtempSync(join(tmpdir(), 'webhook-noti-'))
  try {
    const Database = await NotifierDatabase.Open(Directory)
    Database.SaveDestination({ ExternalId: 'chat-blocked', GuildId: null, IncludePrerelease: false, Kind: 'telegram-chat', Language: 'en', OwnerId: 'owner-a', Platform: 'telegram', Repository, TopicId: null })
    Database.SaveDestination({ ExternalId: 'chat-active', GuildId: null, IncludePrerelease: false, Kind: 'telegram-chat', Language: 'en', OwnerId: 'owner-b', Platform: 'telegram', Repository, TopicId: null })

    const TelegramNotifier: PlatformNotifier = {
      Send(Destination): Promise<void> {
        if (Destination.ExternalId === 'chat-blocked') {
          return Promise.reject(Object.assign(new Error('ETELEGRAM: 403 Forbidden: bot was kicked from the group chat'), { statusCode: 403 }))
        }
        return Promise.resolve()
      }
    }
    const Notifiers = new Map<Destination['Platform'], PlatformNotifier>([['telegram', TelegramNotifier]])

    const Destinations = Database.DestinationsFor(Repository, false)
    const BlockedDest = Destinations.find((Destination) => Destination.ExternalId === 'chat-blocked')
    const ActiveDest = Destinations.find((Destination) => Destination.ExternalId === 'chat-active')
    assert.ok(BlockedDest !== undefined)
    assert.ok(ActiveDest !== undefined)

    await Deliver(Database, Notifiers, BlockedDest, 'release-1', 'Hello')
    await Deliver(Database, Notifiers, ActiveDest, 'release-1', 'Hello')

    assert.deepEqual(Database.DestinationsFor(Repository, false).map((Destination) => Destination.ExternalId), ['chat-active'])
  } finally {
    rmSync(Directory, { force: true, recursive: true })
  }
})