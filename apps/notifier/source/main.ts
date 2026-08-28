import { SafeReleaseMessage, RepositorySlug, type Release } from '@webhook-noti/core'
import { Webhooks } from '@octokit/webhooks'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { NotifierDatabase } from './database.js'
import { Deliver, type PlatformNotifier } from './delivery.js'
import { CreateDiscord } from './discord.js'
import { GetEnvironment } from './env.js'
import { GithubReferenceResolver } from './github.js'
import { CreateTelegram } from './telegram.js'

const ReadBody = async (Request: IncomingMessage): Promise<string> => {
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

const ReleaseFromPayload = (Payload: unknown): Release | null => {
  if (typeof Payload !== 'object' || Payload === null) return null
  // Mirrors the GitHub release webhook JSON payload, whose keys are fixed by GitHub's API.
  // oxlint-disable-next-line crackle/pascal-case
  const Event = Payload as { action?: unknown, repository?: { owner?: { login?: unknown }, name?: unknown }, release?: { name?: unknown, tag_name?: unknown, body?: unknown, author?: { login?: unknown }, html_url?: unknown, prerelease?: unknown } }
  if (Event.action !== 'published' || typeof Event.repository?.owner?.login !== 'string' || typeof Event.repository.name !== 'string') return null
  const ReleasePayload = Event.release
  if (ReleasePayload === undefined || typeof ReleasePayload.tag_name !== 'string' || typeof ReleasePayload.html_url !== 'string') return null
  return {
    Repository: { Owner: Event.repository.owner.login.toLowerCase(), Name: Event.repository.name.toLowerCase() },
    Title: typeof ReleasePayload.name === 'string' && ReleasePayload.name.length > 0 ? ReleasePayload.name : ReleasePayload.tag_name,
    Tag: ReleasePayload.tag_name,
    Body: typeof ReleasePayload.body === 'string' ? ReleasePayload.body : '',
    Author: typeof ReleasePayload.author?.login === 'string' ? ReleasePayload.author.login : 'github',
    Url: ReleasePayload.html_url,
    IsPrerelease: ReleasePayload.prerelease === true
  }
}

const Config = GetEnvironment()
const Database = await NotifierDatabase.Open(Config.DataDirectory)
const Notifiers = new Map<Release['Repository'] extends never ? never : 'discord' | 'telegram', PlatformNotifier>()
if (Config.DiscordToken !== undefined) Notifiers.set('discord', CreateDiscord(Config.DiscordToken, Database, Config.Repositories))
if (Config.TelegramToken !== undefined) Notifiers.set('telegram', CreateTelegram(Config.TelegramToken, Database, Config.Repositories))
const WebhooksClient = new Webhooks({ secret: Config.GithubWebhookSecret })
const ResolveReference = GithubReferenceResolver(Config.GithubToken)

const HandleRequest = async (Request: IncomingMessage, Response: ServerResponse): Promise<void> => {
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
    Response.writeHead(400).end()
    return
  }
  try {
    const Body = await ReadBody(Request)
    if (!await WebhooksClient.verify(Body, Signature)) {
      Response.writeHead(401).end()
      return
    }
    if (EventName !== 'release') {
      Response.writeHead(202).end()
      return
    }
    const ReleaseValue = ReleaseFromPayload(JSON.parse(Body) as unknown)
    if (ReleaseValue === null || !Config.AllowedRepositories.has(RepositorySlug(ReleaseValue.Repository))) {
      Response.writeHead(202).end()
      return
    }
    if (!Database.RecordReceipt(DeliveryId, RepositorySlug(ReleaseValue.Repository))) {
      Response.writeHead(202).end()
      return
    }
    const Content = await SafeReleaseMessage(ReleaseValue, ResolveReference)
    await Promise.all(Database.DestinationsFor(ReleaseValue.Repository, ReleaseValue.IsPrerelease).map(async (Destination) => Deliver(Database, Notifiers, Destination, DeliveryId, Content)))
    Response.writeHead(202).end()
  } catch (CaughtError) {
    console.error(CaughtError)
    Response.writeHead(500).end()
  }
}

const Server = createServer((Request, Response) => {
  void HandleRequest(Request, Response)
})

Server.listen(Config.Port, Config.Host, () => console.log(`Listening on ${Config.Host}:${Config.Port}`))
process.on('SIGTERM', () => Server.close(() => Database.Close()))
