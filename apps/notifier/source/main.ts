import { SafeReleaseMessage, RepositorySlug, type Release } from '@webhook-noti/core'
import { Webhooks } from '@octokit/webhooks'
import { consola } from 'consola'
import { bootstrap } from 'global-agent'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { ProxyAgent } from 'undici'
import { NotifierDatabase } from './database.js'
import { Deliver, type PlatformNotifier } from './delivery.js'
import { CreateDiscord } from './discord.js'
import { GetEnvironment } from './env.js'
import { GithubClient } from './github.js'
import { WaitForPurge } from './purge.js'
import { StartSocksBridge } from './socks-bridge.js'
import { CreateTelegram } from './telegram.js'

const Logger = consola.withTag('notifier')

async function ReadBody(Request: IncomingMessage): Promise<string> {
  const Chunks: Buffer[] = []
  let Size = 0
  for await (const Chunk of Request as AsyncIterable<Buffer>) {
    const Bytes = Buffer.isBuffer(Chunk) ? Chunk : Buffer.from(Chunk)
    Size += Bytes.length
    if (Size > 1_048_576) throw new Error('Webhook payload exceeds 1 MiB')
    Chunks.push(Bytes)
  }
  return Buffer.concat(Chunks).toString('utf8')
}

function ReleaseFromPayload(Payload: unknown): Release | null {
  if (typeof Payload !== 'object' || Payload === null) return null
  // Mirrors the GitHub release webhook JSON payload, whose keys are fixed by GitHub's API.
  // oxlint-disable-next-line crackle/pascal-case
  const Event = Payload as { action?: unknown, repository?: { owner?: { login?: unknown }, name?: unknown }, release?: { name?: unknown, tag_name?: unknown, body?: unknown, author?: { login?: unknown }, html_url?: unknown, prerelease?: unknown, target_commitish?: unknown } }
  if (Event.action !== 'published' || typeof Event.repository?.owner?.login !== 'string' || typeof Event.repository.name !== 'string') return null
  const ReleasePayload = Event.release
  if (ReleasePayload === undefined || typeof ReleasePayload.tag_name !== 'string' || typeof ReleasePayload.html_url !== 'string' || typeof ReleasePayload.target_commitish !== 'string') return null
  return {
    Repository: { Owner: Event.repository.owner.login.toLowerCase(), Name: Event.repository.name.toLowerCase() },
    Title: typeof ReleasePayload.name === 'string' && ReleasePayload.name.length > 0 ? ReleasePayload.name : ReleasePayload.tag_name,
    Tag: ReleasePayload.tag_name,
    Body: typeof ReleasePayload.body === 'string' ? ReleasePayload.body : '',
    Author: typeof ReleasePayload.author?.login === 'string' ? ReleasePayload.author.login : 'github',
    Url: ReleasePayload.html_url,
    IsPrerelease: ReleasePayload.prerelease === true,
    TargetCommitish: ReleasePayload.target_commitish
  }
}

async function Bootstrap(): Promise<void> {
  try {
    const Config = GetEnvironment()
    Logger.info({ message: 'Configuration loaded' })
    const Database = await NotifierDatabase.Open(Config.DataDirectory)
    Logger.info({ message: 'Database opened' })
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
    const Notifiers = new Map<Release['Repository'] extends never ? never : 'discord' | 'telegram', PlatformNotifier>()
    if (Config.DiscordToken !== undefined) Notifiers.set('discord', CreateDiscord(Config.DiscordToken, Database, Config.Repositories, ProxyDispatcher))
    if (Config.TelegramToken !== undefined) Notifiers.set('telegram', CreateTelegram(Config.TelegramToken, Database, Config.Repositories, SocksBridge?.Url))
    Logger.info({ message: 'Platform notifiers initialized', Platforms: [...Notifiers.keys()] })
    const WebhooksClient = new Webhooks({ secret: Config.GithubWebhookSecret })
    const Github = new GithubClient(Config.GithubAppId, Config.GithubAppPrivateKey, ProxyDispatcher)
    const ResolveReference = Github.ResolveReference.bind(Github)

    async function ProcessRelease(ReleaseValue: Release, DeliveryId: string): Promise<void> {
      const Repository = RepositorySlug(ReleaseValue.Repository)
      Logger.info({ message: 'Release processing started', DeliveryId, Repository })
      try {
        await WaitForPurge(Github, ReleaseValue, Config.GlobalpingApiToken, SocksBridge?.Url)
        const Content = await SafeReleaseMessage(ReleaseValue, ResolveReference)
        const Destinations = Database.DestinationsFor(ReleaseValue.Repository, ReleaseValue.IsPrerelease)
        Logger.info({ message: 'Delivery targets selected', DeliveryId, Repository, DestinationCount: Destinations.length })
        await Promise.all(Destinations.map(async (Destination) => Deliver(Database, Notifiers, Destination, DeliveryId, Content)))
        Logger.success({ message: 'Release processing completed', DeliveryId, Repository, DestinationCount: Destinations.length })
      } catch (CaughtError) {
        Logger.error({ message: 'Release processing failed', DeliveryId, Repository, Error: CaughtError })
      }
    }

    async function HandleRequest(Request: IncomingMessage, Response: ServerResponse): Promise<void> {
      if (Request.method === 'GET' && Request.url === '/healthz') {
        Response.writeHead(200).end('ok')
        return
      }
      if (Request.method !== 'POST' || Request.url !== Config.WebhookPath) {
        Response.writeHead(404).end()
        return
      }
      const DeliveryId = Request.headers['x-github-delivery']
      const EventName = Request.headers['x-github-event']
      const Signature = Request.headers['x-hub-signature-256']
      if (typeof DeliveryId !== 'string' || typeof EventName !== 'string' || typeof Signature !== 'string') {
        Logger.warn({ message: 'Webhook rejected: required GitHub headers are missing' })
        Response.writeHead(400).end()
        return
      }
      try {
        const Body = await ReadBody(Request)
        if (!await WebhooksClient.verify(Body, Signature)) {
          Logger.warn({ message: 'Webhook rejected: signature verification failed', DeliveryId, EventName })
          Response.writeHead(401).end()
          return
        }
        if (EventName !== 'release') {
          Logger.info({ message: 'Webhook ignored: unsupported event', DeliveryId, EventName })
          Response.writeHead(202).end()
          return
        }
        const ReleaseValue = ReleaseFromPayload(JSON.parse(Body) as unknown)
        if (ReleaseValue === null || !Config.AllowedRepositories.has(RepositorySlug(ReleaseValue.Repository))) {
          Logger.info({ message: 'Webhook ignored: release is unsupported or repository is not allowed', DeliveryId })
          Response.writeHead(202).end()
          return
        }
        const Repository = RepositorySlug(ReleaseValue.Repository)
        if (!Database.RecordReceipt(DeliveryId, Repository)) {
          Logger.info({ message: 'Webhook ignored: duplicate delivery', DeliveryId, Repository })
          Response.writeHead(202).end()
          return
        }
        Logger.info({ message: 'Webhook accepted', DeliveryId, Repository, Tag: ReleaseValue.Tag, IsPrerelease: ReleaseValue.IsPrerelease })
        // Ack GitHub immediately; resolution and delivery can exceed its webhook timeout.
        Response.writeHead(202).end()
        void ProcessRelease(ReleaseValue, DeliveryId)
      } catch (CaughtError) {
        Logger.error({ message: 'Webhook processing failed', DeliveryId, EventName, Error: CaughtError })
        Response.writeHead(500).end()
      }
    }

    const Server = createServer((Request, Response) => {
      void HandleRequest(Request, Response)
    })

    Server.listen(Config.Port, Config.Host, () => Logger.success({ message: 'Notifier bootstrap completed', Host: Config.Host, Port: Config.Port }))
    process.on('SIGTERM', () => Server.close(() => {
      Logger.info({ message: 'Notifier shutting down' })
      Database.Close()
      void SocksBridge?.Close()
    }))
  } catch (CaughtError) {
    Logger.fatal({ message: 'Notifier bootstrap failed', Error: CaughtError })
    throw CaughtError
  }
}

await Bootstrap()
