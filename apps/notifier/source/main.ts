import { safeReleaseMessage, repositorySlug, type Release } from '@webhook-noti/core'
import { Webhooks } from '@octokit/webhooks'
import { createServer } from 'node:http'
import { NotifierDatabase } from './database.js'
import { deliver, type PlatformNotifier } from './delivery.js'
import { createDiscord } from './discord.js'
import { environment } from './env.js'
import { githubReferenceResolver } from './github.js'
import { createTelegram } from './telegram.js'

const readBody = async (request: import('node:http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 1_048_576) throw new Error('Webhook payload exceeds 1 MiB')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const releaseFromPayload = (payload: unknown): Release | null => {
  if (typeof payload !== 'object' || payload === null) return null
  const event = payload as { action?: unknown, repository?: { owner?: { login?: unknown }, name?: unknown }, release?: { name?: unknown, tag_name?: unknown, body?: unknown, author?: { login?: unknown }, html_url?: unknown, prerelease?: unknown } }
  if (event.action !== 'published' || typeof event.repository?.owner?.login !== 'string' || typeof event.repository.name !== 'string') return null
  const release = event.release
  if (release === undefined || typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') return null
  return {
    repository: { owner: event.repository.owner.login.toLowerCase(), name: event.repository.name.toLowerCase() },
    title: typeof release.name === 'string' && release.name.length > 0 ? release.name : release.tag_name,
    tag: release.tag_name,
    body: typeof release.body === 'string' ? release.body : '',
    author: typeof release.author?.login === 'string' ? release.author.login : 'github',
    url: release.html_url,
    isPrerelease: release.prerelease === true
  }
}

const config = environment()
const database = await NotifierDatabase.open(config.dataDirectory)
const notifiers = new Map<Release['repository'] extends never ? never : 'discord' | 'telegram', PlatformNotifier>()
if (config.discordToken !== undefined) notifiers.set('discord', createDiscord(config.discordToken, database, config.allowedRepositories))
if (config.telegramToken !== undefined) notifiers.set('telegram', createTelegram(config.telegramToken, database, config.allowedRepositories))
const webhooks = new Webhooks({ secret: config.githubWebhookSecret })
const resolveReference = githubReferenceResolver(config.githubToken)

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200).end('ok')
    return
  }
  if (request.method !== 'POST' || request.url !== config.webhookPath) {
    response.writeHead(404).end()
    return
  }
  const deliveryId = request.headers['x-github-delivery']
  const eventName = request.headers['x-github-event']
  const signature = request.headers['x-hub-signature-256']
  if (typeof deliveryId !== 'string' || typeof eventName !== 'string' || typeof signature !== 'string') {
    response.writeHead(400).end()
    return
  }
  try {
    const body = await readBody(request)
    if (!await webhooks.verify(body, signature)) {
      response.writeHead(401).end()
      return
    }
    if (eventName !== 'release') {
      response.writeHead(202).end()
      return
    }
    const release = releaseFromPayload(JSON.parse(body) as unknown)
    if (release === null || !config.allowedRepositories.has(repositorySlug(release.repository))) {
      response.writeHead(202).end()
      return
    }
    if (!database.recordReceipt(deliveryId, repositorySlug(release.repository))) {
      response.writeHead(202).end()
      return
    }
    const content = await safeReleaseMessage(release, resolveReference)
    await Promise.all(database.destinationsFor(release.repository, release.isPrerelease).map(async (destination) => deliver(database, notifiers, destination, deliveryId, content)))
    response.writeHead(202).end()
  } catch (error) {
    console.error(error)
    response.writeHead(500).end()
  }
})

server.listen(config.port, config.host, () => console.log(`Listening on ${config.host}:${config.port}`))
process.on('SIGTERM', () => server.close(() => database.close()))