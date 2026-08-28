import { ParseRepository, RepositorySlug, type Repository } from '@webhook-noti/core'
import { resolve } from 'node:path'

const Required = (Name: string): string => {
  const Value = process.env[Name]?.trim()
  if (Value === undefined || Value.length === 0) throw new Error(`${Name} is required`)
  return Value
}

const AllowedRepositories = (Value: string): Set<string> => {
  const Repositories = Value.split(',').map(ParseRepository)
  if (Repositories.some((Repository) => Repository === null)) {
    throw new Error('ALLOWED_REPOSITORIES must be a comma-separated owner/repository list')
  }
  return new Set(Repositories.map((Repository) => RepositorySlug(Repository as Repository)))
}

export interface Environment {
  AllowedRepositories: Set<string>
  DataDirectory: string
  DiscordToken: string | undefined
  GithubToken: string
  GithubWebhookSecret: string
  Host: string
  Port: number
  TelegramToken: string | undefined
  WebhookPath: string
}

export const GetEnvironment = (): Environment => {
  const Port = Number(process.env.PORT ?? '3000')
  if (!Number.isSafeInteger(Port) || Port < 1 || Port > 65_535) throw new Error('PORT must be a valid TCP port')
  const WebhookPath = process.env.WEBHOOK_PATH?.trim() || '/webhook/github'
  if (!WebhookPath.startsWith('/')) throw new Error('WEBHOOK_PATH must begin with /')

  return {
    AllowedRepositories: AllowedRepositories(Required('ALLOWED_REPOSITORIES')),
    DataDirectory: resolve(process.env.DATA_DIR?.trim() || '/var/lib/webhook-noti'),
    DiscordToken: process.env.DISCORD_BOT_TOKEN?.trim() || undefined,
    GithubToken: Required('GITHUB_TOKEN'),
    GithubWebhookSecret: Required('GITHUB_WEBHOOK_SECRET'),
    Host: process.env.HOST?.trim() || '0.0.0.0',
    Port,
    TelegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    WebhookPath
  }
}
