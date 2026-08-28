import { RepositorySlug } from './repository.js'
import type { GitHubReference, ReferenceResolver, Release } from './types.js'

const MaxMessageLength = 3_800

const StripMarkdown = (Value: string): string => Value
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 <$2>')
  .replace(/^\s{0,3}#{1,6}\s+/gm, '')
  .replace(/^\s*[-*+]\s+/gm, '- ')
  .replace(/(`{1,3})([\s\S]*?)\1/g, '$2')
  .replace(/(\*\*|__|\*|_|~~)/g, '')
  .replace(/>\s?/g, '')

const NeutralizeMentions = (Value: string): string => Value
  .replace(/<[@#][!&]?\d+>/g, (Mention) => Mention.replace('@', '@\u200b').replace('#', '#\u200b'))
  .replace(/@/g, '@\u200b')
  .replace(/#(?=[a-zA-Z][\w-]*)/g, '#\u200b')

const ReferencePattern = /(?<![\w/])(?:(?<Owner>[a-zA-Z0-9_.-]+)\/(?<Name>[a-zA-Z0-9_.-]+))?#(?<Number>\d+)\b/g

const ReferenceUrl = (Reference: GitHubReference, Kind: 'issue' | 'pull'): string =>
  `https://github.com/${RepositorySlug(Reference.Repository)}/${Kind === 'pull' ? 'pull' : 'issues'}/${Reference.Number}`

export const SafeReleaseMessage = async (Release: Release, ResolveReference: ReferenceResolver): Promise<string> => {
  const Raw = [
    `${Release.Repository.Owner}/${Release.Repository.Name} ${Release.Tag}`,
    Release.Title,
    Release.Body
  ].filter(Boolean).join('\n\n')
  const References = new Map<string, Promise<'issue' | 'pull'>>()
  const Rendered = await ReplaceAsync(StripMarkdown(Raw), ReferencePattern, async (Match, ...Arguments: unknown[]) => {
    const Groups = Arguments.at(-1) as { Owner?: string, Name?: string, Number: string }
    const Repository = Groups.Owner !== undefined && Groups.Name !== undefined
      ? { Owner: Groups.Owner.toLowerCase(), Name: Groups.Name.toLowerCase() }
      : Release.Repository
    const ReferenceValue = { Repository, Number: Number(Groups.Number) }
    const Key = `${RepositorySlug(Repository)}#${Groups.Number}`
    const Kind = References.get(Key) ?? Promise.resolve(ResolveReference(ReferenceValue)).catch(() => 'issue' as const)
    References.set(Key, Kind)
    return `${Match} <${ReferenceUrl(ReferenceValue, await Kind)}>`
  })
  const Message = NeutralizeMentions(Rendered).replace(/\n{3,}/g, '\n\n').trim()
  const Suffix = `\n\n${Release.Url}`
  return Message.length + Suffix.length > MaxMessageLength
    ? `${Message.slice(0, MaxMessageLength - Suffix.length - 3).trimEnd()}...${Suffix}`
    : `${Message}${Suffix}`
}

const ReplaceAsync = async (
  Value: string,
  Pattern: RegExp,
  Replacement: (Match: string, ...Arguments: unknown[]) => Promise<string>
): Promise<string> => {
  const Matches = [...Value.matchAll(Pattern)]
  const Replacements = await Promise.all(Matches.map((Match) => Replacement(Match[0], ...Match.slice(1), Match.index, Match.input, Match.groups)))
  let Offset = 0
  return Matches.reduce((Result, Match, Index) => {
    const ReplacementValue = Replacements[Index]
    if (ReplacementValue === undefined || Match.index === undefined) return Result
    const Next = Result.slice(0, Match.index + Offset) + ReplacementValue + Result.slice(Match.index + Offset + Match[0].length)
    Offset += ReplacementValue.length - Match[0].length
    return Next
  }, Value)
}