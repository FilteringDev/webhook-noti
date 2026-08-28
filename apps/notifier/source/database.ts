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
  language: Language
  direct_message: number
  include_prerelease: number
}
/* oxlint-enable crackle/pascal-case */

export interface SaveDestination {
  ExternalId: string
  IncludePrerelease: boolean
  Kind: Destination['Kind']
  Language: Language
  OwnerId: string
  Platform: Platform
  Repository: Repository
  TopicId: number | null
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
      '  repository_owner TEXT NOT NULL,',
      '  repository_name TEXT NOT NULL,',
      '  language TEXT NOT NULL CHECK (language IN (\'en\', \'ko\')) DEFAULT \'en\',',
      '  direct_message INTEGER NOT NULL CHECK (direct_message IN (0, 1)),',
      '  include_prerelease INTEGER NOT NULL CHECK (include_prerelease IN (0, 1)) DEFAULT 0,',
      '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '  UNIQUE (platform, kind, external_id, topic_id, repository_owner, repository_name)',
      ');',
      'CREATE TABLE IF NOT EXISTS webhook_receipts (',
      '  delivery_id TEXT PRIMARY KEY,',
      '  repository TEXT NOT NULL,',
      '  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
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
      '  github_delivery_id TEXT NOT NULL,',
      '  status TEXT NOT NULL CHECK (status IN (\'sent\', \'failed\')),',
      '  error_message TEXT,',
      '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
      ');'
    ].join('\n'))
    NotifierDatabaseInstance.#Persist()
    return NotifierDatabaseInstance
  }

  Close(): void {
    this.#Persist()
    this.#Database.close()
  }

  SaveDestination(Destination: SaveDestination): void {
    this.#Database.run([
      'INSERT INTO destinations (',
      '  platform, kind, external_id, topic_id, owner_id, repository_owner, repository_name, language, direct_message, include_prerelease',
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'ON CONFLICT(platform, kind, external_id, topic_id, repository_owner, repository_name) DO UPDATE SET',
      '  owner_id = excluded.owner_id, language = excluded.language, include_prerelease = excluded.include_prerelease'
    ].join('\n'), [
      Destination.Platform, Destination.Kind, Destination.ExternalId, Destination.TopicId, Destination.OwnerId,
      Destination.Repository.Owner, Destination.Repository.Name, Destination.Language,
      Destination.Kind.endsWith('-dm') ? 1 : 0, Destination.IncludePrerelease ? 1 : 0
    ])
    this.#Persist()
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

  RecordReceipt(DeliveryId: string, Repository: string): boolean {
    this.#Database.run('INSERT OR IGNORE INTO webhook_receipts (delivery_id, repository) VALUES (?, ?)', [DeliveryId, Repository])
    const Inserted = this.#Database.getRowsModified() === 1
    if (Inserted) this.#Persist()
    return Inserted
  }

  RecordAttempt(DestinationId: number, DeliveryId: string, Status: 'sent' | 'failed', ErrorMessage?: string): void {
    this.#Database.run([
      'INSERT INTO delivery_attempts (destination_id, github_delivery_id, status, error_message)',
      'VALUES (?, ?, ?, ?)'
    ].join('\n'), [DestinationId, DeliveryId, Status, ErrorMessage ?? null])
    this.#Persist()
  }

  #Persist(): void {
    const TemporaryPath = `${this.#Path}.tmp`
    writeFileSync(TemporaryPath, this.#Database.export(), { mode: 0o600 })
    renameSync(TemporaryPath, this.#Path)
  }
}
