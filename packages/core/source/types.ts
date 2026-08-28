export type Language = 'en' | 'ko'

export type Platform = 'discord' | 'telegram'

export type DestinationKind =
  | 'discord-channel'
  | 'discord-dm'
  | 'telegram-chat'
  | 'telegram-topic'
  | 'telegram-dm'

export interface Repository {
  owner: string
  name: string
}

export interface Release {
  repository: Repository
  title: string
  tag: string
  body: string
  author: string
  url: string
  isPrerelease: boolean
}

export interface Destination {
  id: number
  platform: Platform
  kind: DestinationKind
  externalId: string
  topicId: number | null
  ownerId: string
  language: Language
  directMessage: boolean
  includePrerelease: boolean
}

export type ReferenceKind = 'issue' | 'pull'

export interface GitHubReference {
  repository: Repository
  number: number
}

export type ReferenceResolver = (reference: GitHubReference) => Promise<ReferenceKind>