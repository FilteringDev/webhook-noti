import { parseRepository, repositorySlug, type Repository } from '@webhook-noti/core'
import { resolve } from 'node:path'

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

const allowedRepositories = (value: string): Set<string> => {
  const repositories = value.split(',').map(parseRepository)
  if (repositories.some((repository) => repository === null)) {
    throw new Error('ALLOWED_REPOSITORIES must be a comma-separated owner/repository list')
  }
  return new Set(repositories.map((repository) => repositorySlug(repository as Repository)))
}

export interface Environment {
  allowedRepositories: Set<string>
  dataDirectory: string
  discordToken: string | undefined
  githubToken: string
  githubWebhookSecret: string
  host: string
  port: number
  telegramToken: string | undefined
  webhookPath: string
}

export const environment = (): Environment => {
  const port = Number(process.env.PORT ?? '3000')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port')
  const webhookPath = process.env.WEBHOOK_PATH?.trim() || '/webhook/github'
  if (!webhookPath.startsWith('/')) throw new Error('WEBHOOK_PATH must begin with /')

  return {
    allowedRepositories: allowedRepositories(required('ALLOWED_REPOSITORIES')),
    dataDirectory: resolve(process.env.DATA_DIR?.trim() || '/var/lib/webhook-noti'),
    discordToken: process.env.DISCORD_BOT_TOKEN?.trim() || undefined,
    githubToken: required('GITHUB_TOKEN'),
    githubWebhookSecret: required('GITHUB_WEBHOOK_SECRET'),
    host: process.env.HOST?.trim() || '0.0.0.0',
    port,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    webhookPath
  }
}