import { RepositorySlug, type Repository } from '@webhook-noti/core'
import type { GithubClient } from './github.js'
import { Logger as RootLogger } from './logging.js'

const Logger = RootLogger.withTag('installations')
const RefreshIntervalMilliseconds = 10 * 60 * 1_000

export class InstallationRegistry {
  readonly #Github: GithubClient
  #Repositories: Repository[] = []
  #Slugs = new Set<string>()
  #Timer: NodeJS.Timeout | undefined

  constructor(Github: GithubClient) {
    this.#Github = Github
  }

  List(): Repository[] {
    return this.#Repositories
  }

  Has(Slug: string): boolean {
    return this.#Slugs.has(Slug)
  }

  async Refresh(): Promise<void> {
    try {
      const Installations = await this.#Github.Installations()
      const Repositories = (await Promise.all(Installations.map(async (Id) => this.#Github.InstallationRepositories(Id)))).flat()
      const Unique = new Map(Repositories.map((Value) => [RepositorySlug(Value), Value]))
      this.#Repositories = [...Unique.values()]
      this.#Slugs = new Set(Unique.keys())
      Logger.info({ message: 'Installed repositories refreshed', InstallationCount: Installations.length, RepositoryCount: this.#Repositories.length })
    } catch (CaughtError) {
      // A transient GitHub outage must not empty the subscription menu.
      Logger.warn({ message: 'Installed repository refresh failed; keeping the previous list', Error: CaughtError })
    }
  }

  Start(): void {
    this.#Timer = setInterval(() => {
      void this.Refresh()
    }, RefreshIntervalMilliseconds)
    this.#Timer.unref()
  }

  Stop(): void {
    if (this.#Timer !== undefined) clearInterval(this.#Timer)
    this.#Timer = undefined
  }
}
