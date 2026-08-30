import { createConsola, LogLevels, type ConsolaInstance, type ConsolaReporter, type LogObject } from 'consola'
import type { Writable } from 'node:stream'

const RedactedValue = '[REDACTED]'
const CircularValue = '[Circular]'
const InternalLogKeys = new Set(['additional', 'args', 'date', 'level', 'message', 'tag', 'type'])
const SensitiveKeyFragments = ['apikey', 'authorization', 'cookie', 'credential', 'password', 'privatekey', 'secret', 'token'] as const

type LogOutput = Pick<Writable, 'once' | 'write'>

function ErrorDescription(CaughtError: unknown): string {
  if (CaughtError instanceof Error) return CaughtError.message
  try {
    return String(CaughtError)
  } catch {
    return 'Unknown serialization error'
  }
}

function IsSensitiveKey(Key: string): boolean {
  const NormalizedKey = Key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
  return SensitiveKeyFragments.some((Fragment) => NormalizedKey.includes(Fragment))
}

function PropertyValue(Value: object, Key: string, Ancestors: Set<object>): unknown {
  if (IsSensitiveKey(Key)) return RedactedValue
  try {
    return NormalizeValue((Value as Record<string, unknown>)[Key], Ancestors)
  } catch (CaughtError) {
    return `[Unserializable: ${ErrorDescription(CaughtError)}]`
  }
}

function NormalizeError(Value: Error, Ancestors: Set<object>): Record<string, unknown> {
  const Result: Record<string, unknown> = {
    name: Value.name,
    message: Value.message
  }
  if (Value.stack !== undefined) Result.stack = Value.stack
  if (Value.cause !== undefined) Result.cause = NormalizeValue(Value.cause, Ancestors)
  for (const Key of Object.keys(Value)) {
    if (['cause', 'message', 'name', 'stack'].includes(Key)) continue
    Result[Key] = PropertyValue(Value, Key, Ancestors)
  }
  return Result
}

function NormalizeValue(Value: unknown, Ancestors: Set<object>): unknown {
  if (Value === null || typeof Value === 'string' || typeof Value === 'boolean') return Value
  if (typeof Value === 'number') return Number.isFinite(Value) ? Value : String(Value)
  if (typeof Value === 'bigint') return String(Value)
  if (typeof Value === 'undefined') return undefined
  if (typeof Value === 'function' || typeof Value === 'symbol') return String(Value)
  if (Value instanceof Date) return Number.isNaN(Value.getTime()) ? String(Value) : Value.toISOString()
  if (Value instanceof URL) return String(Value)
  if (Ancestors.has(Value)) return CircularValue

  Ancestors.add(Value)
  try {
    if (Value instanceof Error) return NormalizeError(Value, Ancestors)
    if (Array.isArray(Value)) {
      return Value.map((Item) => NormalizeValue(Item, Ancestors))
    }
    if (Value instanceof Map) {
      return [...Value.entries()].map(([Key, Item]) => ({
        key: NormalizeValue(Key, Ancestors),
        value: NormalizeValue(Item, Ancestors)
      }))
    }
    if (Value instanceof Set) return [...Value].map((Item) => NormalizeValue(Item, Ancestors))

    const Result: Record<string, unknown> = {}
    for (const Key of Object.keys(Value)) Result[Key] = PropertyValue(Value, Key, Ancestors)
    return Result
  } catch (CaughtError) {
    return `[Unserializable: ${ErrorDescription(CaughtError)}]`
  } finally {
    Ancestors.delete(Value)
  }
}

function LogTimestamp(LogValue: LogObject): string {
  return Number.isNaN(LogValue.date.getTime()) ? new Date().toISOString() : LogValue.date.toISOString()
}

export function SerializeLog(LogValue: LogObject): string {
  try {
    const Arguments = LogValue.args as unknown[]
    const [FirstArgument, ...RemainingArguments] = Arguments
    const Message = typeof FirstArgument === 'string' ? FirstArgument : ''
    const Context: Record<string, unknown> = {}
    for (const Key of Object.keys(LogValue)) {
      if (!InternalLogKeys.has(Key)) Context[Key] = (LogValue as Record<string, unknown>)[Key]
    }
    const AdditionalArguments = typeof FirstArgument === 'string' ? RemainingArguments : Arguments
    if (AdditionalArguments.length > 0) Context.arguments = AdditionalArguments

    return JSON.stringify({
      timestamp: LogTimestamp(LogValue),
      level: LogValue.type,
      tag: LogValue.tag,
      message: Message,
      context: NormalizeValue(Context, new Set<object>())
    })
  } catch (CaughtError) {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      tag: 'logger',
      message: 'Log serialization failed',
      context: { error: ErrorDescription(CaughtError) }
    })
  }
}

function CreateReporter(Output: LogOutput): ConsolaReporter {
  const Pending: string[] = []
  let WaitingForDrain = false

  function Drain(): void {
    if (WaitingForDrain) return
    while (Pending.length > 0) {
      const Line = Pending.shift()
      if (Line === undefined) return
      if (!Output.write(Line)) {
        WaitingForDrain = true
        Output.once('drain', () => {
          WaitingForDrain = false
          Drain()
        })
        return
      }
    }
  }

  return {
    log: (LogValue) => {
      Pending.push(`${SerializeLog(LogValue)}\n`)
      Drain()
    }
  }
}

export function CreateJsonLogger(Output: LogOutput = process.stdout): ConsolaInstance {
  return createConsola({ level: LogLevels.info, reporters: [CreateReporter(Output)], throttle: 0 })
}

export const Logger = CreateJsonLogger()
