import { Octokit } from '@octokit/rest'
import type { ReferenceKind, ReferenceResolver } from '@webhook-noti/core'
import type { Dispatcher } from 'undici'

export function GithubReferenceResolver(Token: string, ProxyDispatcher?: Dispatcher): ReferenceResolver {
  const OctokitClient = new Octokit({
    auth: Token,
    ...(ProxyDispatcher === undefined ? {} : {
      request: {
        // undici's fetch accepts a non-standard `dispatcher` init option; the lowercase name is its actual API contract.
        // oxlint-disable-next-line crackle/pascal-case
        fetch: async (Url: string | URL | Request, Init?: RequestInit) => fetch(Url, { ...Init, dispatcher: ProxyDispatcher } as RequestInit & { dispatcher: Dispatcher })
      }
    })
  })
  return async function (Reference): Promise<ReferenceKind> {
    const Response = await OctokitClient.rest.issues.get({
      owner: Reference.Repository.Owner,
      repo: Reference.Repository.Name,
      issue_number: Reference.Number
    })
    return Response.data.pull_request === undefined ? 'issue' : 'pull'
  }
}
