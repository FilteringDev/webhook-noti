export type Language = 'en' | 'ko'

export type Platform = 'discord' | 'telegram'

export type DestinationKind =
  | 'discord-channel'
  | 'discord-dm'
  | 'telegram-chat'
  | 'telegram-topic'
  | 'telegram-dm'

export interface Repository {
  Owner: string
  Name: string
}

export interface Release {
  Repository: Repository
  Title: string
  Tag: string
  Body: string
  Author: string
  Url: string
  IsPrerelease: boolean
  TargetCommitish: string
}

export interface Destination {
  Id: number
  Platform: Platform
  Kind: DestinationKind
  ExternalId: string
  TopicId: number | null
  OwnerId: string
  Language: Language
  DirectMessage: boolean
  IncludePrerelease: boolean
}

export type ReferenceKind = 'issue' | 'pull'

export interface GitHubReference {
  Repository: Repository
  Number: number
}

export type ReferenceResolver = (reference: GitHubReference) => Promise<ReferenceKind>