import type { Repository } from './types.js'

const RepositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/

export const ParseRepository = (Value: string): Repository | null => {
  const Normalized = Value.trim().toLowerCase()
  if (!RepositoryPattern.test(Normalized)) return null

  const [Owner, Name] = Normalized.split('/')
  if (Owner === undefined || Name === undefined) return null
  return { Owner, Name }
}

export const RepositorySlug = (Repository: Repository): string => `${Repository.Owner}/${Repository.Name}`
