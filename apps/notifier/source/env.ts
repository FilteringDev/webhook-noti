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

export interface Environment {
  DataDirectory: string
  DiscordToken: string | undefined
  GithubAppId: string
  GithubAppPrivateKey: string
  GlobalpingApiToken: string
  Host: string
  Port: number
  SocksProxyUrl: string | undefined
  TelegramToken: string | undefined
}

export function GetEnvironment(): Environment {
  const Port = Number(process.env.PORT ?? '3000')
  if (!Number.isSafeInteger(Port) || Port < 1 || Port > 65_535) throw new Error('PORT must be a valid TCP port')

  return {
    DataDirectory: resolve(process.env.DATA_DIR?.trim() || '/var/lib/webhook-noti'),
    DiscordToken: Secret('DISCORD_BOT_TOKEN', false),
    GithubAppId: Required('GITHUB_APP_ID'),
    GithubAppPrivateKey: Secret('GITHUB_APP_PRIVATE_KEY', true) as string,
    GlobalpingApiToken: Secret('GLOBALPING_API_TOKEN', true) as string,
    Host: process.env.HOST?.trim() || '0.0.0.0',
    Port,
    SocksProxyUrl: process.env.SOCKS_PROXY_URL?.trim() || undefined,
    TelegramToken: Secret('TELEGRAM_BOT_TOKEN', false)
  }
}
