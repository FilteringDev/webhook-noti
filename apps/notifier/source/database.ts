import type { Destination, Language, Platform, Repository } from '@webhook-noti/core'
import initSqlJs, { type Database } from 'sql.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Mirrors sql.js getAsObject() output, whose keys are the raw SQL column names.
/* oxlint-disable crackle/pascal-case */
interface DestinationRow {
  id: number
  platform: Platform
  kind: Destination['Kind']
  external_id: string
  topic_id: number | null
  owner_id: string
  guild_id: string | null
  language: Language
  direct_message: number
  include_prerelease: number
}

interface SubscriptionRouteRow extends DestinationRow {
  repository_owner: string
  repository_name: string
}
/* oxlint-enable crackle/pascal-case */

export interface SaveDestination {
  ExternalId: string
  GuildId: string | null
  IncludePrerelease: boolean
  Kind: Destination['Kind']
  Language: Language
  OwnerId: string
  Platform: Platform
  Repository: Repository
  TopicId: number | null
}

export interface SubscriptionRoute extends Destination {
  Repository: Repository
}

export interface ReleaseWatermark {
  ETag: string | undefined
  PublishedAt: string
}

export type ActiveDestination = 'discord-server' | 'discord-user' | 'telegram-chat' | 'telegram-user'

export interface ActiveDestinationSummary {
  DiscordServers: number
  DiscordUsers: number
  TelegramChats: number
  TelegramUsers: number
}

export class NotifierDatabase {
  readonly #Database: Database
  readonly #Path: string

  private constructor(Database: Database, Path: string) {
    this.#Database = Database
    this.#Path = Path
  }

  static async Open(Directory: string): Promise<NotifierDatabase> {
    mkdirSync(Directory, { recursive: true, mode: 0o700 })
    const Path = join(Directory, 'notifier.sqlite')
    const SQL = await initSqlJs()
    const Database = new SQL.Database(existsSync(Path) ? readFileSync(Path) : undefined)
    const NotifierDatabaseInstance = new NotifierDatabase(Database, Path)
    Database.run('PRAGMA foreign_keys = ON;')
    Database.run([
      'CREATE TABLE IF NOT EXISTS destinations (',
      '  id INTEGER PRIMARY KEY,',
      '  platform TEXT NOT NULL CHECK (platform IN (\'discord\', \'telegram\')),',
      '  kind TEXT NOT NULL,',
      '  external_id TEXT NOT NULL,',
      '  topic_id INTEGER,',
      '  owner_id TEXT NOT NULL,',
      '  guild_id TEXT,',
      '  repository_owner TEXT NOT NULL,',
      '  repository_name TEXT NOT NULL,',
      '  language TEXT NOT NULL CHECK (language IN (\'en\', \'ko\')) DEFAULT \'en\',',
      '  direct_message INTEGER NOT NULL CHECK (direct_message IN (0, 1)),',
      '  include_prerelease INTEGER NOT NULL CHECK (include_prerelease IN (0, 1)) DEFAULT 0,',
      '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '  UNIQUE (platform, kind, external_id, topic_id, repository_owner, repository_name)',
      ');',
      'CREATE TABLE IF NOT EXISTS release_receipts (',
      '  repository TEXT NOT NULL,',
      '  release_id INTEGER NOT NULL,',
      '  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '  PRIMARY KEY (repository, release_id)',
      ');',
      'CREATE TABLE IF NOT EXISTS release_watermarks (',
      '  repository TEXT PRIMARY KEY,',
      '  last_published_at TEXT NOT NULL,',
      '  etag TEXT,',
      '  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
      ');',
      'CREATE TABLE IF NOT EXISTS user_settings (',
      '  platform TEXT NOT NULL CHECK (platform IN (\'discord\', \'telegram\')),',
      '  external_id TEXT NOT NULL,',
      '  language TEXT NOT NULL CHECK (language IN (\'en\', \'ko\')),',
      '  PRIMARY KEY (platform, external_id)',
      ');',
      'CREATE TABLE IF NOT EXISTS delivery_attempts (',
      '  id INTEGER PRIMARY KEY,',
      '  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,',
      '  release_key TEXT NOT NULL,',
      '  status TEXT NOT NULL CHECK (status IN (\'sent\', \'failed\')),',
      '  error_message TEXT,',
      '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
      ');',
      'DROP TABLE IF EXISTS webhook_receipts;'
    ].join('\n'))
    const DestinationColumns = Database.exec('PRAGMA table_info(destinations)')[0]?.values ?? []
    if (!DestinationColumns.some((Column) => Column[1] === 'guild_id')) Database.run('ALTER TABLE destinations ADD COLUMN guild_id TEXT')
    const AttemptColumns = Database.exec('PRAGMA table_info(delivery_attempts)')[0]?.values ?? []
    if (AttemptColumns.some((Column) => Column[1] === 'github_delivery_id')) Database.run('ALTER TABLE delivery_attempts RENAME COLUMN github_delivery_id TO release_key')
    NotifierDatabaseInstance.#Persist()
    return NotifierDatabaseInstance
  }

  Close(): void {
    this.#Persist()
    this.#Database.close()
  }

  SaveDestination(Destination: SaveDestination): ActiveDestination | undefined {
    const Activated = this.#ActivatedDestination(Destination)
    this.#Database.run([
      'INSERT INTO destinations (',
      '  platform, kind, external_id, topic_id, owner_id, guild_id, repository_owner, repository_name, language, direct_message, include_prerelease',
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'ON CONFLICT(platform, kind, external_id, topic_id, repository_owner, repository_name) DO UPDATE SET',
      '  owner_id = excluded.owner_id, guild_id = excluded.guild_id, language = excluded.language, include_prerelease = excluded.include_prerelease'
    ].join('\n'), [
      Destination.Platform, Destination.Kind, Destination.ExternalId, Destination.TopicId, Destination.OwnerId, Destination.GuildId,
      Destination.Repository.Owner, Destination.Repository.Name, Destination.Language,
      Destination.Kind.endsWith('-dm') ? 1 : 0, Destination.IncludePrerelease ? 1 : 0
    ])
    this.#Persist()
    return Activated
  }

  ActiveDestinationSummary(): ActiveDestinationSummary {
    return {
      DiscordServers: this.#Count('SELECT COUNT(DISTINCT guild_id) FROM destinations WHERE platform = ? AND direct_message = 0 AND guild_id IS NOT NULL', ['discord']),
      DiscordUsers: this.#Count('SELECT COUNT(DISTINCT external_id) FROM destinations WHERE platform = ? AND direct_message = 1', ['discord']),
      TelegramChats: this.#Count('SELECT COUNT(DISTINCT external_id) FROM destinations WHERE platform = ? AND direct_message = 0', ['telegram']),
      TelegramUsers: this.#Count('SELECT COUNT(DISTINCT external_id) FROM destinations WHERE platform = ? AND direct_message = 1', ['telegram'])
    }
  }

  LanguageFor(Platform: Platform, ExternalId: string): Language {
    const Statement = this.#Database.prepare('SELECT language FROM user_settings WHERE platform = ? AND external_id = ?')
    Statement.bind([Platform, ExternalId])
    const Row = Statement.step() ? Statement.getAsObject() : undefined
    Statement.free()
    return Row?.language === 'ko' ? 'ko' : 'en'
  }

  SetLanguage(Platform: Platform, ExternalId: string, Language: Language): void {
    this.#Database.run([
      'INSERT INTO user_settings (platform, external_id, language) VALUES (?, ?, ?)',
      'ON CONFLICT(platform, external_id) DO UPDATE SET language = excluded.language'
    ].join('\n'), [Platform, ExternalId, Language])
    this.#Persist()
  }

  RemoveDestination(Platform: Platform, ExternalId: string, Repository: Repository, TopicId: number | null = null): boolean {
    this.#Database.run([
      'DELETE FROM destinations',
      'WHERE platform = ? AND external_id = ? AND repository_owner = ? AND repository_name = ?',
      '  AND (topic_id IS ? OR topic_id = ?)'
    ].join('\n'), [Platform, ExternalId, Repository.Owner, Repository.Name, TopicId, TopicId])
    const Changed = this.#Database.getRowsModified() > 0
    if (Changed) this.#Persist()
    return Changed
  }

  ForgetDiscordGuild(GuildId: string): void {
    this.#Database.run('DELETE FROM destinations WHERE platform = ? AND guild_id = ?', ['discord', GuildId])
    this.#Persist()
  }

  ForgetTelegramChat(ExternalId: string): void {
    this.#Database.run('DELETE FROM destinations WHERE platform = ? AND external_id = ?', ['telegram', ExternalId])
    this.#Persist()
  }

  ForgetDirectMessage(Platform: Platform, ExternalId: string): void {
    this.#Database.run('BEGIN')
    try {
      this.#Database.run('DELETE FROM destinations WHERE platform = ? AND external_id = ? AND direct_message = 1', [Platform, ExternalId])
      this.#Database.run('DELETE FROM user_settings WHERE platform = ? AND external_id = ?', [Platform, ExternalId])
      this.#Database.run('COMMIT')
    } catch (CaughtError) {
      this.#Database.run('ROLLBACK')
      throw CaughtError
    }
    this.#Persist()
  }

  ForgetDestination(Destination: Destination): void {
    if (Destination.DirectMessage) {
      this.ForgetDirectMessage(Destination.Platform, Destination.ExternalId)
    } else if (Destination.Platform === 'telegram') {
      this.ForgetTelegramChat(Destination.ExternalId)
    } else {
      this.#Database.run('DELETE FROM destinations WHERE platform = ? AND external_id = ?', ['discord', Destination.ExternalId])
      this.#Persist()
    }
  }

  DestinationsFor(Repository: Repository, IsPrerelease: boolean): Destination[] {
    const Statement = this.#Database.prepare([
      'SELECT id, platform, kind, external_id, topic_id, owner_id, language, direct_message, include_prerelease',
      'FROM destinations',
      'WHERE repository_owner = ? AND repository_name = ? AND (? = 0 OR include_prerelease = 1)'
    ].join('\n'))
    Statement.bind([Repository.Owner, Repository.Name, IsPrerelease ? 1 : 0])
    const Rows: DestinationRow[] = []
    while (Statement.step()) Rows.push(Statement.getAsObject() as unknown as DestinationRow)
    Statement.free()
    return Rows.map((Row) => ({
      Id: Row.id,
      Platform: Row.platform,
      Kind: Row.kind,
      ExternalId: Row.external_id,
      TopicId: Row.topic_id,
      OwnerId: Row.owner_id,
      Language: Row.language,
      DirectMessage: Row.direct_message === 1,
      IncludePrerelease: Row.include_prerelease === 1
    }))
  }

  RoutesFor(Platform: Platform, ExternalIds: string[]): SubscriptionRoute[] {
    if (ExternalIds.length === 0) return []
    const Placeholders = ExternalIds.map(() => '?').join(', ')
    const Statement = this.#Database.prepare([
      'SELECT id, platform, kind, external_id, topic_id, owner_id, language, direct_message, include_prerelease, repository_owner, repository_name',
      'FROM destinations',
      `WHERE platform = ? AND external_id IN (${Placeholders}) AND direct_message = 0`,
      'ORDER BY repository_owner, repository_name, external_id, topic_id'
    ].join('\n'))
    Statement.bind([Platform, ...ExternalIds])
    const Rows: SubscriptionRouteRow[] = []
    while (Statement.step()) Rows.push(Statement.getAsObject() as unknown as SubscriptionRouteRow)
    Statement.free()
    return Rows.map((Row) => ({
      Id: Row.id,
      Platform: Row.platform,
      Kind: Row.kind,
      ExternalId: Row.external_id,
      TopicId: Row.topic_id,
      OwnerId: Row.owner_id,
      Language: Row.language,
      DirectMessage: Row.direct_message === 1,
      IncludePrerelease: Row.include_prerelease === 1,
      Repository: { Owner: Row.repository_owner, Name: Row.repository_name }
    }))
  }

  RecordRelease(Repository: string, ReleaseId: number): boolean {
    this.#Database.run('INSERT OR IGNORE INTO release_receipts (repository, release_id) VALUES (?, ?)', [Repository, ReleaseId])
    const Inserted = this.#Database.getRowsModified() === 1
    if (Inserted) this.#Persist()
    return Inserted
  }

  Watermark(Repository: string): ReleaseWatermark | undefined {
    const Statement = this.#Database.prepare('SELECT last_published_at, etag FROM release_watermarks WHERE repository = ?')
    Statement.bind([Repository])
    const Row = Statement.step() ? Statement.getAsObject() : undefined
    Statement.free()
    if (Row === undefined || typeof Row.last_published_at !== 'string') return undefined
    return { ETag: typeof Row.etag === 'string' ? Row.etag : undefined, PublishedAt: Row.last_published_at }
  }

  SaveWatermark(Repository: string, PublishedAt: string, ETag: string | undefined): void {
    this.#Database.run([
      'INSERT INTO release_watermarks (repository, last_published_at, etag, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      'ON CONFLICT(repository) DO UPDATE SET last_published_at = excluded.last_published_at, etag = excluded.etag, updated_at = excluded.updated_at'
    ].join('\n'), [Repository, PublishedAt, ETag ?? null])
    this.#Persist()
  }

  HasDestination(Id: number): boolean {
    const Statement = this.#Database.prepare('SELECT 1 FROM destinations WHERE id = ?')
    Statement.bind([Id])
    const Exists = Statement.step()
    Statement.free()
    return Exists
  }

  RecordAttempt(DestinationId: number, ReleaseKey: string, Status: 'sent' | 'failed', ErrorMessage?: string): void {
    this.#Database.run([
      'INSERT INTO delivery_attempts (destination_id, release_key, status, error_message)',
      'VALUES (?, ?, ?, ?)'
    ].join('\n'), [DestinationId, ReleaseKey, Status, ErrorMessage ?? null])
    this.#Persist()
  }

  #ActivatedDestination(Destination: SaveDestination): ActiveDestination | undefined {
    const ActiveDestination = Destination.Kind === 'discord-channel' && Destination.GuildId !== null
      ? 'discord-server'
      : Destination.Kind === 'discord-dm'
        ? 'discord-user'
        : Destination.Kind === 'telegram-dm'
          ? 'telegram-user'
          : Destination.Platform === 'telegram'
            ? 'telegram-chat'
            : undefined
    if (ActiveDestination === undefined) return undefined
    let Query: string
    let Parameters: (string | null)[]
    if (ActiveDestination === 'discord-server') {
      Query = 'SELECT 1 FROM destinations WHERE platform = ? AND direct_message = 0 AND guild_id = ?'
      Parameters = ['discord', Destination.GuildId]
    } else if (ActiveDestination === 'discord-user') {
      Query = 'SELECT 1 FROM destinations WHERE platform = ? AND direct_message = 1 AND external_id = ?'
      Parameters = ['discord', Destination.ExternalId]
    } else if (ActiveDestination === 'telegram-chat') {
      Query = 'SELECT 1 FROM destinations WHERE platform = ? AND direct_message = 0 AND external_id = ?'
      Parameters = ['telegram', Destination.ExternalId]
    } else {
      Query = 'SELECT 1 FROM destinations WHERE platform = ? AND direct_message = 1 AND external_id = ?'
      Parameters = ['telegram', Destination.ExternalId]
    }
    const Statement = this.#Database.prepare(Query)
    Statement.bind(Parameters)
    const AlreadyActive = Statement.step()
    Statement.free()
    return AlreadyActive ? undefined : ActiveDestination
  }

  #Count(Query: string, Parameters: string[]): number {
    const Statement = this.#Database.prepare(Query)
    Statement.bind(Parameters)
    const Count = Statement.step() ? Statement.get()[0] : 0
    Statement.free()
    return typeof Count === 'number' ? Count : 0
  }

  #Persist(): void {
    const TemporaryPath = `${this.#Path}.tmp`
    writeFileSync(TemporaryPath, this.#Database.export(), { mode: 0o600 })
    renameSync(TemporaryPath, this.#Path)
  }
}
