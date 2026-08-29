import { ParseRepository, RepositorySlug, type Repository } from '@webhook-noti/core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function Required(Name: string): string {
  const Value = process.env[Name]?.trim()
  if (Value === undefined || Value.length === 0) throw new Error(`${Name} is required`)
  return Value
}

function Secret(Name: string, RequiredSecret: boolean): string | undefined {
  const Path = process.env[`${Name}_FILE`]?.trim()
  if (Path === undefined || Path.length === 0) {
    if (RequiredSecret) throw new Error(`${Name}_FILE is required`)
    return undefined
  }
  const Value = readFileSync(Path, 'utf8').trim()
  if (Value.length === 0 && RequiredSecret) throw new Error(`${Name}_FILE must not be empty`)
  if (Value.length === 0) return undefined
  return Value
}

function AllowedRepositories(Value: string): Repository[] {
  const Repositories = Value.split(',').map(ParseRepository)
  if (Repositories.length === 0 || Repositories.some((Repository) => Repository === null)) {
    throw new Error('ALLOWED_REPOSITORIES must be a comma-separated owner/repository list')
  }
  return Repositories.map((Repository) => Repository as Repository)
}

export interface Environment {
  AllowedRepositories: Set<string>
  Repositories: Repository[]
  DataDirectory: string
  DiscordToken: string | undefined
  GithubAppId: string
  GithubAppPrivateKey: string
  GithubWebhookSecret: string
  GlobalpingApiToken: string
  Host: string
  Port: number
  SocksProxyUrl: string | undefined
  TelegramToken: string | undefined
  WebhookPath: string
}

export function GetEnvironment(): Environment {
  const Port = Number(process.env.PORT ?? '3000')
  if (!Number.isSafeInteger(Port) || Port < 1 || Port > 65_535) throw new Error('PORT must be a valid TCP port')
  const WebhookPath = process.env.WEBHOOK_PATH?.trim() || '/webhook/github'
  if (!WebhookPath.startsWith('/')) throw new Error('WEBHOOK_PATH must begin with /')

  const Repositories = AllowedRepositories(Required('ALLOWED_REPOSITORIES'))
  return {
    AllowedRepositories: new Set(Repositories.map(RepositorySlug)),
    Repositories,
    DataDirectory: resolve(process.env.DATA_DIR?.trim() || '/var/lib/webhook-noti'),
    DiscordToken: Secret('DISCORD_BOT_TOKEN', false),
    GithubAppId: Required('GITHUB_APP_ID'),
    GithubAppPrivateKey: Secret('GITHUB_APP_PRIVATE_KEY', true) as string,
    GithubWebhookSecret: Secret('GITHUB_WEBHOOK_SECRET', true) as string,
    GlobalpingApiToken: Secret('GLOBALPING_API_TOKEN', true) as string,
    Host: process.env.HOST?.trim() || '0.0.0.0',
    Port,
    SocksProxyUrl: process.env.SOCKS_PROXY_URL?.trim() || undefined,
    TelegramToken: Secret('TELEGRAM_BOT_TOKEN', false),
    WebhookPath
  }
}
