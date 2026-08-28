import { Octokit } from '@octokit/rest'
import type { ReferenceKind, ReferenceResolver } from '@webhook-noti/core'

export const githubReferenceResolver = (token: string): ReferenceResolver => {
  const octokit = new Octokit({ auth: token })
  return async (reference): Promise<ReferenceKind> => {
    const response = await octokit.rest.issues.get({
      owner: reference.repository.owner,
      repo: reference.repository.name,
      issue_number: reference.number
    })
    return response.data.pull_request === undefined ? 'issue' : 'pull'
  }
}