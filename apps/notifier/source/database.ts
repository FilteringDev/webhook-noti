import type { Destination, Language, Platform, Repository } from '@webhook-noti/core'
import initSqlJs, { type Database } from 'sql.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface DestinationRow {
  id: number
  platform: Platform
  kind: Destination['kind']
  external_id: string
  topic_id: number | null
  owner_id: string
  language: Language
  direct_message: number
  include_prerelease: number
}

export interface SaveDestination {
  externalId: string
  includePrerelease: boolean
  kind: Destination['kind']
  language: Language
  ownerId: string
  platform: Platform
  repository: Repository
  topicId: number | null
}

export class NotifierDatabase {
  readonly #database: Database
  readonly #path: string

  private constructor(database: Database, path: string) {
    this.#database = database
    this.#path = path
  }

  static async open(directory: string): Promise<NotifierDatabase> {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'notifier.sqlite')
    const SQL = await initSqlJs()
    const database = new SQL.Database(existsSync(path) ? readFileSync(path) : undefined)
    const notifierDatabase = new NotifierDatabase(database, path)
    database.run('PRAGMA foreign_keys = ON;')
    database.run(`
      CREATE TABLE IF NOT EXISTS destinations (
        id INTEGER PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform IN ('discord', 'telegram')),
        kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        topic_id INTEGER,
        owner_id TEXT NOT NULL,
        repository_owner TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        language TEXT NOT NULL CHECK (language IN ('en', 'ko')) DEFAULT 'en',
        direct_message INTEGER NOT NULL CHECK (direct_message IN (0, 1)),
        include_prerelease INTEGER NOT NULL CHECK (include_prerelease IN (0, 1)) DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (platform, kind, external_id, topic_id, repository_owner, repository_name)
      );
      CREATE TABLE IF NOT EXISTS webhook_receipts (
        delivery_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        platform TEXT NOT NULL CHECK (platform IN ('discord', 'telegram')),
        external_id TEXT NOT NULL,
        language TEXT NOT NULL CHECK (language IN ('en', 'ko')),
        PRIMARY KEY (platform, external_id)
      );
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id INTEGER PRIMARY KEY,
        destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
        github_delivery_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    notifierDatabase.#persist()
    return notifierDatabase
  }

  close(): void {
    this.#persist()
    this.#database.close()
  }

  saveDestination(destination: SaveDestination): void {
    this.#database.run(`
      INSERT INTO destinations (
        platform, kind, external_id, topic_id, owner_id, repository_owner, repository_name, language, direct_message, include_prerelease
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, kind, external_id, topic_id, repository_owner, repository_name) DO UPDATE SET
        owner_id = excluded.owner_id, language = excluded.language, include_prerelease = excluded.include_prerelease
    `, [
      destination.platform, destination.kind, destination.externalId, destination.topicId, destination.ownerId,
      destination.repository.owner, destination.repository.name, destination.language,
      destination.kind.endsWith('-dm') ? 1 : 0, destination.includePrerelease ? 1 : 0
    ])
    this.#persist()
  }

  languageFor(platform: Platform, externalId: string): Language {
    const statement = this.#database.prepare('SELECT language FROM user_settings WHERE platform = ? AND external_id = ?')
    statement.bind([platform, externalId])
    const row = statement.step() ? statement.getAsObject() : undefined
    statement.free()
    return row?.language === 'ko' ? 'ko' : 'en'
  }

  setLanguage(platform: Platform, externalId: string, language: Language): void {
    this.#database.run(`
      INSERT INTO user_settings (platform, external_id, language) VALUES (?, ?, ?)
      ON CONFLICT(platform, external_id) DO UPDATE SET language = excluded.language
    `, [platform, externalId, language])
    this.#persist()
  }

  removeDestination(platform: Platform, externalId: string, repository: Repository, topicId: number | null = null): boolean {
    this.#database.run(`
      DELETE FROM destinations
      WHERE platform = ? AND external_id = ? AND repository_owner = ? AND repository_name = ?
        AND (topic_id IS ? OR topic_id = ?)
    `, [platform, externalId, repository.owner, repository.name, topicId, topicId])
    const changed = this.#database.getRowsModified() > 0
    if (changed) this.#persist()
    return changed
  }

  destinationsFor(repository: Repository, isPrerelease: boolean): Destination[] {
    const statement = this.#database.prepare(`
      SELECT id, platform, kind, external_id, topic_id, owner_id, language, direct_message, include_prerelease
      FROM destinations
      WHERE repository_owner = ? AND repository_name = ? AND (? = 0 OR include_prerelease = 1)
    `)
    statement.bind([repository.owner, repository.name, isPrerelease ? 1 : 0])
    const rows: DestinationRow[] = []
    while (statement.step()) rows.push(statement.getAsObject() as unknown as DestinationRow)
    statement.free()
    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      kind: row.kind,
      externalId: row.external_id,
      topicId: row.topic_id,
      ownerId: row.owner_id,
      language: row.language,
      directMessage: row.direct_message === 1,
      includePrerelease: row.include_prerelease === 1
    }))
  }

  recordReceipt(deliveryId: string, repository: string): boolean {
    this.#database.run('INSERT OR IGNORE INTO webhook_receipts (delivery_id, repository) VALUES (?, ?)', [deliveryId, repository])
    const inserted = this.#database.getRowsModified() === 1
    if (inserted) this.#persist()
    return inserted
  }

  recordAttempt(destinationId: number, deliveryId: string, status: 'sent' | 'failed', errorMessage?: string): void {
    this.#database.run(`
      INSERT INTO delivery_attempts (destination_id, github_delivery_id, status, error_message)
      VALUES (?, ?, ?, ?)
    `, [destinationId, deliveryId, status, errorMessage ?? null])
    this.#persist()
  }

  #persist(): void {
    const temporaryPath = `${this.#path}.tmp`
    writeFileSync(temporaryPath, this.#database.export(), { mode: 0o600 })
    renameSync(temporaryPath, this.#path)
  }
}