export interface DiscordFailureResponse {
  Deferred: boolean
  Replied: boolean
  EditReply: (Content: string) => Promise<void>
  Reply: (Content: string) => Promise<void>
}

function ObjectValue(Value: unknown): Record<string, unknown> | undefined {
  return Value !== null && typeof Value === 'object' ? Value as Record<string, unknown> : undefined
}

export function DiscordInteractionErrorDetails(CaughtError: unknown): { Code: number | string | undefined, Detail: string, Status: number | undefined } {
  const ErrorValue = ObjectValue(CaughtError)
  const Code = ErrorValue?.code
  const Status = ErrorValue?.status
  const Detail = ErrorValue?.message
  return {
    Code: typeof Code === 'number' || typeof Code === 'string' ? Code : undefined,
    Detail: typeof Detail === 'string' ? Detail : String(CaughtError),
    Status: typeof Status === 'number' ? Status : undefined
  }
}

export async function ReplyWithFailure(Response: DiscordFailureResponse, Content: string): Promise<void> {
  if (Response.Replied) return
  if (Response.Deferred) await Response.EditReply(Content)
  else await Response.Reply(Content)
}