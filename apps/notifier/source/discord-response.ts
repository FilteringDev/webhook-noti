export interface DiscordFailureResponse {
  Deferred: boolean
  Replied: boolean
  EditReply: (Content: string) => Promise<void>
  Reply: (Content: string) => Promise<void>
}

export async function ReplyWithFailure(Response: DiscordFailureResponse, Content: string): Promise<void> {
  if (Response.Replied) return
  if (Response.Deferred) await Response.EditReply(Content)
  else await Response.Reply(Content)
}