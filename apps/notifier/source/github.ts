import { Octokit } from '@octokit/rest'
import type { ReferenceKind, ReferenceResolver } from '@webhook-noti/core'

export function GithubReferenceResolver(Token: string): ReferenceResolver {
  const OctokitClient = new Octokit({ auth: Token })
  return async function (Reference): Promise<ReferenceKind> {
    const Response = await OctokitClient.rest.issues.get({
      owner: Reference.Repository.Owner,
      repo: Reference.Repository.Name,
      issue_number: Reference.Number
    })
    return Response.data.pull_request === undefined ? 'issue' : 'pull'
  }
}
