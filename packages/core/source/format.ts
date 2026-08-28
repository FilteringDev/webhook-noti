import { repositorySlug } from './repository.js'
import type { GitHubReference, ReferenceResolver, Release } from './types.js'

const maxMessageLength = 3_800

const stripMarkdown = (value: string): string => value
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 <$2>')
  .replace(/^\s{0,3}#{1,6}\s+/gm, '')
  .replace(/^\s*[-*+]\s+/gm, '- ')
  .replace(/(`{1,3})([\s\S]*?)\1/g, '$2')
  .replace(/(\*\*|__|\*|_|~~)/g, '')
  .replace(/>\s?/g, '')

const neutralizeMentions = (value: string): string => value
  .replace(/<[@#][!&]?\d+>/g, (mention) => mention.replace('@', '@\u200b').replace('#', '#\u200b'))
  .replace(/@/g, '@\u200b')
  .replace(/#(?=[a-zA-Z][\w-]*)/g, '#\u200b')

const referencePattern = /(?<![\w/])(?:(?<owner>[a-zA-Z0-9_.-]+)\/(?<name>[a-zA-Z0-9_.-]+))?#(?<number>\d+)\b/g

const referenceUrl = (reference: GitHubReference, kind: 'issue' | 'pull'): string =>
  `https://github.com/${repositorySlug(reference.repository)}/${kind === 'pull' ? 'pull' : 'issues'}/${reference.number}`

export const safeReleaseMessage = async (release: Release, resolveReference: ReferenceResolver): Promise<string> => {
  const raw = [
    `${release.repository.owner}/${release.repository.name} ${release.tag}`,
    release.title,
    release.body
  ].filter(Boolean).join('\n\n')
  const references = new Map<string, Promise<'issue' | 'pull'>>()
  const rendered = await replaceAsync(stripMarkdown(raw), referencePattern, async (match, ...arguments_: unknown[]) => {
    const groups = arguments_.at(-1) as { owner?: string, name?: string, number: string }
    const repository = groups.owner !== undefined && groups.name !== undefined
      ? { owner: groups.owner.toLowerCase(), name: groups.name.toLowerCase() }
      : release.repository
    const reference = { repository, number: Number(groups.number) }
    const key = `${repositorySlug(repository)}#${groups.number}`
    const kind = references.get(key) ?? Promise.resolve(resolveReference(reference)).catch(() => 'issue' as const)
    references.set(key, kind)
    return `${match} <${referenceUrl(reference, await kind)}>`
  })
  const message = neutralizeMentions(rendered).replace(/\n{3,}/g, '\n\n').trim()
  const suffix = `\n\n${release.url}`
  return message.length + suffix.length > maxMessageLength
    ? `${message.slice(0, maxMessageLength - suffix.length - 3).trimEnd()}...${suffix}`
    : `${message}${suffix}`
}

const replaceAsync = async (
  value: string,
  pattern: RegExp,
  replacement: (match: string, ...arguments_: unknown[]) => Promise<string>
): Promise<string> => {
  const matches = [...value.matchAll(pattern)]
  const replacements = await Promise.all(matches.map((match) => replacement(match[0], ...match.slice(1), match.index, match.input, match.groups)))
  let offset = 0
  return matches.reduce((result, match, index) => {
    const replacementValue = replacements[index]
    if (replacementValue === undefined || match.index === undefined) return result
    const next = result.slice(0, match.index + offset) + replacementValue + result.slice(match.index + offset + match[0].length)
    offset += replacementValue.length - match[0].length
    return next
  }, value)
}