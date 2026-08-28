import type { Repository } from './types.js'

const repositoryPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/

export const parseRepository = (value: string): Repository | null => {
  const normalized = value.trim().toLowerCase()
  if (!repositoryPattern.test(normalized)) return null

  const [owner, name] = normalized.split('/')
  if (owner === undefined || name === undefined) return null
  return { owner, name }
}

export const repositorySlug = (repository: Repository): string => `${repository.owner}/${repository.name}`