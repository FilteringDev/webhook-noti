import { SafeReleaseMessage, RepositorySlug, type Release } from '@webhook-noti/core'
import { consola } from 'consola'
import { bootstrap } from 'global-agent'
import { createServer } from 'node:http'
import { ProxyAgent } from 'undici'
import { NotifierDatabase } from './database.js'
import { Deliver, type PlatformNotifier } from './delivery.js'
import { CreateDiscord } from './discord.js'
import { GetEnvironment } from './env.js'
import { GithubClient } from './github.js'
import { InstallationRegistry } from './installations.js'
import { CreateReleasePoller } from './poller.js'
import { WaitForPurge } from './purge.js'
import { StartSocksBridge } from './socks-bridge.js'
import { CreateTelegram } from './telegram.js'

const Logger = consola.withTag('notifier')

async function Bootstrap(): Promise<void> {
  try {
    const Config = GetEnvironment()
    Logger.info({ message: 'Configuration loaded' })
    const Database = await NotifierDatabase.Open(Config.DataDirectory)
    Logger.info({ message: 'Database opened' })
    const ActiveDestinations = Database.ActiveDestinationSummary()
    Logger.info({ message: `Active destinations loaded: Discord servers=${ActiveDestinations.DiscordServers}, Discord users=${ActiveDestinations.DiscordUsers}, Telegram chats=${ActiveDestinations.TelegramChats}, Telegram users=${ActiveDestinations.TelegramUsers}` })
    const SocksBridge = Config.SocksProxyUrl === undefined ? undefined : await StartSocksBridge(Config.SocksProxyUrl)
    const ProxyDispatcher = SocksBridge === undefined ? undefined : new ProxyAgent(SocksBridge.Url)
    if (SocksBridge !== undefined) {
      // Routes the Discord Gateway WebSocket login through the bridge too, since @discordjs/ws has no direct proxy hook.
      bootstrap()
      // global-agent's contract requires this exact casing (globalThis.GLOBAL_AGENT.{HTTP,HTTPS}_PROXY).
      /* oxlint-disable crackle/pascal-case */
      const GlobalAgentConfig = (globalThis as unknown as { GLOBAL_AGENT: { HTTP_PROXY: string | null, HTTPS_PROXY: string | null } }).GLOBAL_AGENT
      GlobalAgentConfig.HTTP_PROXY = SocksBridge.Url
      GlobalAgentConfig.HTTPS_PROXY = SocksBridge.Url
      /* oxlint-enable crackle/pascal-case */
      Logger.info({ message: 'SOCKS proxy bridge started' })
    }
    const Github = new GithubClient(Config.GithubAppId, Config.GithubAppPrivateKey, ProxyDispatcher)
    const Installations = new InstallationRegistry(Github)
    await Installations.Refresh()
    if (Installations.List().length === 0) Logger.warn({ message: 'GitHub App is not installed on any repository yet' })
    Installations.Start()
    const Notifiers = new Map<Release['Repository'] extends never ? never : 'discord' | 'telegram', PlatformNotifier>()
    if (Config.DiscordToken !== undefined) Notifiers.set('discord', CreateDiscord(Config.DiscordToken, Database, () => Installations.List(), ProxyDispatcher))
    if (Config.TelegramToken !== undefined) Notifiers.set('telegram', CreateTelegram(Config.TelegramToken, Database, () => Installations.List(), SocksBridge?.Url))
    Logger.info({ message: 'Platform notifiers initialized', Platforms: [...Notifiers.keys()] })
    const ResolveReference = Github.ResolveReference.bind(Github)

    async function ProcessRelease(ReleaseValue: Release, ReleaseKey: string): Promise<void> {
      const Repository = RepositorySlug(ReleaseValue.Repository)
      Logger.info({ message: 'Release processing started', ReleaseKey, Repository })
      try {
        await WaitForPurge(Github, ReleaseValue, Config.GlobalpingApiToken, SocksBridge?.Url)
        const Content = await SafeReleaseMessage(ReleaseValue, ResolveReference)
        const Destinations = Database.DestinationsFor(ReleaseValue.Repository, ReleaseValue.IsPrerelease)
        Logger.info({ message: 'Delivery targets selected', ReleaseKey, Repository, DestinationCount: Destinations.length })
        await Promise.all(Destinations.map(async (Destination) => Deliver(Database, Notifiers, Destination, ReleaseKey, Content)))
        Logger.success({ message: 'Release processing completed', ReleaseKey, Repository, DestinationCount: Destinations.length })
      } catch (CaughtError) {
        Logger.error({ message: 'Release processing failed', ReleaseKey, Repository, Error: CaughtError })
      }
    }

    const Poller = CreateReleasePoller({
      Database,
      Github,
      // Purge confirmation can take minutes, so delivery must not block the next poll.
      OnRelease: (ReleaseValue, ReleaseKey) => void ProcessRelease(ReleaseValue, ReleaseKey),
      Repositories: Installations
    })
    Poller.Start()

    const Server = createServer((Request, Response) => {
      if (Request.method === 'GET' && Request.url === '/healthz') Response.writeHead(200).end('ok')
      else Response.writeHead(404).end()
    })

    Server.listen(Config.Port, Config.Host, () => Logger.success({ message: 'Notifier bootstrap completed', Host: Config.Host, Port: Config.Port }))
    process.on('SIGTERM', () => Server.close(() => {
      Logger.info({ message: 'Notifier shutting down' })
      Poller.Stop()
      Installations.Stop()
      Database.Close()
      void SocksBridge?.Close()
    }))
  } catch (CaughtError) {
    Logger.fatal({ message: 'Notifier bootstrap failed', Error: CaughtError })
    throw CaughtError
  }
}

await Bootstrap()
