import { Message, type Destination, type Language, type Repository } from '@webhook-noti/core'
import { Bot, TelegramApiError, type InlineKeyboardMarkup, type SendMessageParams } from 'node-telegram-bot-api/node'
import { ProxyAgent, type Dispatcher } from 'undici'
import { RunGuarded } from './async-guard.js'
import type { NotifierDatabase } from './database.js'
import { IsTransientError, type PlatformNotifier } from './delivery.js'
import { ForgetConfirmation, type ForgetScope } from './forget.js'
import { Logger as RootLogger } from './logging.js'
import { RepositorySelector, type SelectionPage } from './selection.js'

const Logger = RootLogger.withTag('telegram')

function ObjectValue(Value: unknown): Record<string, unknown> | undefined {
  return Value !== null && typeof Value === 'object' ? Value as Record<string, unknown> : undefined
}

export function PollingErrorDetails(CaughtError: unknown): { Code: string | undefined, Detail: string, Status: number | undefined } {
  if (CaughtError instanceof TelegramApiError) {
    return { Code: CaughtError.code, Detail: CaughtError.message, Status: CaughtError.errorCode }
  }
  const ErrorValue = ObjectValue(CaughtError)
  const ResponseValue = ObjectValue(ErrorValue?.response)
  const Code = ErrorValue?.code
  const Status = ErrorValue?.statusCode ?? ErrorValue?.status ?? ResponseValue?.statusCode ?? ResponseValue?.status
  const Message = ErrorValue?.message
  return {
    Code: typeof Code === 'string' ? Code : undefined,
    Detail: typeof Message === 'string' ? Message : String(CaughtError),
    Status: typeof Status === 'number' ? Status : undefined
  }
}

function ParseCommand(Text: string): { Command: string, Argument: string | undefined } {
  const [Command = '', Argument] = Text.trim().split(/\s+/, 2)
  return { Command: Command.replace(/@[^\s]+$/, '').toLowerCase(), Argument }
}

function Keyboard(Page: SelectionPage): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...Page.Repositories.map((Repository, Index) => [{ text: `${Repository.Owner}/${Repository.Name}`, callback_data: `repository-select:${Page.Id}:${Index}` }]),
      ...(Page.PageCount > 1 ? [[
        { text: 'Previous', callback_data: `repository-previous:${Page.Id}` },
        { text: 'Next', callback_data: `repository-next:${Page.Id}` }
      ]] : [])
    ]
  }
}

function ForgetKeyboard(Id: string, Language: Language): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: Message(Language, 'forgetConfirm'), callback_data: `forget-confirm:${Id}` },
      { text: Message(Language, 'forgetCancel'), callback_data: `forget-cancel:${Id}` }
    ]]
  }
}

export function TelegramNotificationOptions(TopicId: number | null): Pick<SendMessageParams, 'link_preview_options' | 'message_thread_id'> {
  return {
    ...(TopicId === null ? {} : { message_thread_id: TopicId }),
    link_preview_options: { is_disabled: true }
  }
}

export function CreateTelegram(Token: string, Database: NotifierDatabase, ListRepositories: () => Repository[], ProxyUrl?: string): PlatformNotifier {
  const ProxyDispatcher = ProxyUrl === undefined ? undefined : new ProxyAgent(ProxyUrl)
  const Telegram = new Bot(Token, {
    ...(ProxyDispatcher === undefined ? {} : {
      // undici's fetch accepts a non-standard `dispatcher` init option; the lowercase name is its actual API contract.
      // oxlint-disable-next-line crackle/pascal-case
      fetch: (Url, Init) => fetch(Url, { ...Init, dispatcher: ProxyDispatcher } as RequestInit & { dispatcher: Dispatcher })
    })
  })
  const Selector = new RepositorySelector(ListRepositories)
  const ForgetConfirmations = new ForgetConfirmation()
  Telegram.on('message', (Context) => {
    RunGuarded(async () => {
    const Update = Context.message
    if (Update === undefined) return
    if (Update.text === undefined || Update.from === undefined) return
    const ChatId = Update.chat.id
    const MessageThreadId = Update.message_thread_id
    const SenderId = Update.from.id
    const { Command, Argument } = ParseCommand(Update.text)
    if (!['/subscribe', '/unsubscribe', '/language', '/dm', '/routes', '/forget'].includes(Command)) return
    const Language: Language = Command === '/language'
      ? Argument === 'ko' ? 'ko' : 'en'
      : Database.LanguageFor('telegram', String(Update.from.id))
    async function Send(Text: string): Promise<void> {
      await Telegram.api.sendMessage({ chat_id: ChatId, text: Text, ...(MessageThreadId === undefined ? {} : { message_thread_id: MessageThreadId }) })
    }
    async function SendPermissionDenied(): Promise<void> {
      try {
        await Telegram.api.sendMessage({ chat_id: SenderId, text: Message(Language, 'forbidden') })
      } catch {}
    }
    if (Command === '/language') {
      Database.SetLanguage('telegram', String(Update.from.id), Language)
      await Send(Message(Language, 'languageSaved'))
      return
    }
    const DirectMessage = Update.chat.type === 'private'
    if (Command === '/forget') {
      if (!DirectMessage) {
        const Administrators = await Telegram.api.getChatAdministrators({ chat_id: Update.chat.id })
        if (!Administrators.some((Administrator) => Administrator.user.id === Update.from?.id)) {
          await SendPermissionDenied()
          return
        }
      }
      const ExternalId = String(Update.chat.id)
      const Scope: ForgetScope = DirectMessage
        ? { Platform: 'telegram', Type: 'dm', ExternalId }
        : { Platform: 'telegram', Type: 'chat', ExternalId }
      const Id = ForgetConfirmations.Create(String(Update.from.id), ExternalId, Scope)
      await Telegram.api.sendMessage({ chat_id: Update.chat.id, text: Message(Language, DirectMessage ? 'forgetDmWarning' : 'forgetChatWarning'), ...(Update.message_thread_id === undefined ? {} : { message_thread_id: Update.message_thread_id }), reply_markup: ForgetKeyboard(Id, Language) })
      return
    }
    if (!DirectMessage) {
      const Administrators = await Telegram.api.getChatAdministrators({ chat_id: Update.chat.id })
      if (!Administrators.some((Administrator) => Administrator.user.id === Update.from?.id)) {
        await SendPermissionDenied()
        return
      }
    }
    if (Command === '/routes') {
      const Routes = Database.RoutesFor('telegram', [String(Update.chat.id)])
      const Content = Routes.length === 0
        ? Message(Language, 'routesEmpty')
        : [
            Message(Language, 'routesHeading'),
            ...Routes.map((Route) => `${Route.Repository.Owner}/${Route.Repository.Name} -> ${Route.TopicId === null ? Message(Language, 'routesChat') : `${Message(Language, 'routesTopic')} #${Route.TopicId}`}`)
          ].join('\n')
      await Send(Content.slice(0, 4_096))
      return
    }
    const ExternalId = String(Update.chat.id)
    const TopicId = Update.message_thread_id ?? null
    const Action = Command === '/unsubscribe' ? 'unsubscribe' : Command === '/dm' ? 'dm-enable' : 'subscribe'
    const Page = Selector.Create({ Action, ExternalId, IncludePrerelease: false, OwnerId: String(Update.from.id), SourceId: ExternalId, TopicId })
      await Telegram.api.sendMessage({ chat_id: Update.chat.id, text: 'Select a repository.', ...(TopicId === null ? {} : { message_thread_id: TopicId }), reply_markup: Keyboard(Page) })
    }, (CaughtError) => Logger.error({ message: 'Telegram message handler failed', Error: CaughtError }))
  })
  Telegram.on('callback_query', (TelegramContext) => {
    RunGuarded(async () => {
    const Callback = TelegramContext.callbackQuery
    if (Callback === undefined) return
    if (Callback.message === undefined || Callback.data === undefined) return
    const [Operation, Id, Index] = Callback.data.split(':', 3)
    if (Operation === 'forget-confirm' || Operation === 'forget-cancel') {
      const MessageValue = Callback.message
      const ExternalId = String(MessageValue.chat.id)
      const Language = Database.LanguageFor('telegram', String(Callback.from.id))
      if (Operation === 'forget-confirm' && MessageValue.chat.type !== 'private') {
        const Administrators = await Telegram.api.getChatAdministrators({ chat_id: MessageValue.chat.id })
        if (!Administrators.some((Administrator) => Administrator.user.id === Callback.from.id)) {
          await Telegram.api.answerCallbackQuery({ callback_query_id: Callback.id, text: Message(Language, 'forbidden'), show_alert: true })
          return
        }
      }
      const Scope = Id === undefined ? null : ForgetConfirmations.Take(Id, String(Callback.from.id), ExternalId)
      if (Scope === null || Scope.Platform !== 'telegram') await Telegram.api.editMessageText({ chat_id: MessageValue.chat.id, message_id: MessageValue.message_id, text: Message(Language, 'forgetExpired') })
      else if (Operation === 'forget-cancel') await Telegram.api.editMessageText({ chat_id: MessageValue.chat.id, message_id: MessageValue.message_id, text: Message(Language, 'forgetCancelled') })
      else {
        if (Scope.Type === 'dm') Database.ForgetDirectMessage('telegram', Scope.ExternalId)
        else Database.ForgetTelegramChat(Scope.ExternalId)
        await Telegram.api.editMessageText({ chat_id: MessageValue.chat.id, message_id: MessageValue.message_id, text: Message(Language, 'forgotten') })
      }
      await Telegram.api.answerCallbackQuery({ callback_query_id: Callback.id })
      return
    }
    if (Id === undefined || !['repository-select', 'repository-previous', 'repository-next'].includes(Operation ?? '')) return
    const MessageValue = Callback.message
    const ExternalId = String(MessageValue.chat.id)
    const TopicId = 'message_thread_id' in MessageValue ? MessageValue.message_thread_id ?? null : null
    const SelectionContext = { OwnerId: String(Callback.from.id), SourceId: ExternalId, TopicId }
    const Language = Database.LanguageFor('telegram', String(Callback.from.id))
    const DirectMessage = MessageValue.chat.type === 'private'
    if (!DirectMessage) {
      const Administrators = await Telegram.api.getChatAdministrators({ chat_id: MessageValue.chat.id })
      if (!Administrators.some((Administrator) => Administrator.user.id === Callback.from.id)) {
        await Telegram.api.answerCallbackQuery({ callback_query_id: Callback.id, text: Message(Language, 'forbidden'), show_alert: true })
        return
      }
    }
    if (Operation === 'repository-previous' || Operation === 'repository-next') {
      const Page = Operation === 'repository-previous' ? Selector.Previous(Id, SelectionContext) : Selector.Next(Id, SelectionContext)
      if (Page === null) await Telegram.api.answerCallbackQuery({ callback_query_id: Callback.id, text: Message(Language, 'selectionExpired'), show_alert: true })
      else {
        await Telegram.api.editMessageReplyMarkup({ chat_id: MessageValue.chat.id, message_id: MessageValue.message_id, reply_markup: Keyboard(Page) })
        await Telegram.api.answerCallbackQuery({ callback_query_id: Callback.id })
      }
      return
    }
    const Selected = Selector.Select(Id, SelectionContext, Index ?? '')
    if (Selected === null) {
      await Telegram.api.answerCallbackQuery({ callback_query_id: Callback.id, text: Message(Language, 'selectionExpired'), show_alert: true })
      return
    }
    let Result: Parameters<typeof Message>[1]
    if (Selected.Action === 'unsubscribe') Result = Database.RemoveDestination('telegram', Selected.ExternalId, Selected.Repository, Selected.TopicId) ? 'unsubscribed' : 'failed'
    else {
      const Kind: Destination['Kind'] = DirectMessage ? 'telegram-dm' : Selected.TopicId === null ? 'telegram-chat' : 'telegram-topic'
      const Activated = Database.SaveDestination({ ExternalId: Selected.ExternalId, GuildId: null, IncludePrerelease: Selected.IncludePrerelease, Kind, Language, OwnerId: String(Callback.from.id), Platform: 'telegram', Repository: Selected.Repository, TopicId: Selected.TopicId })
      if (Activated !== undefined) {
        const Summary = Database.ActiveDestinationSummary()
        const ActiveDestinationCount = Activated === 'telegram-chat' ? Summary.TelegramChats : Summary.TelegramUsers
        Logger.info({ message: `Active destination added: ${Activated}, total=${ActiveDestinationCount}` })
      }
      Result = Selected.Action === 'dm-enable' ? 'dmEnabled' : 'subscribed'
    }
    await Telegram.api.editMessageText({ chat_id: MessageValue.chat.id, message_id: MessageValue.message_id, text: Message(Language, Result) })
      await Telegram.api.answerCallbackQuery({ callback_query_id: Callback.id })
    }, (CaughtError) => Logger.error({ message: 'Telegram callback query handler failed', Error: CaughtError }))
  })
  Telegram.catch((CaughtError) => {
    const Details = PollingErrorDetails(CaughtError)
    const Hint = Details.Status === 401
      ? 'Check the Telegram bot token.'
      : Details.Status === 409
        ? 'The library removed any configured webhook and will retry. Ensure no other bot instance uses this token.'
        : undefined
    const Log = { ...Details, ...(Hint === undefined ? {} : { Hint }) }
    if (IsTransientError(CaughtError)) Logger.warn({ message: 'Telegram update failed', ...Log })
    else Logger.error({ message: 'Telegram update was rejected', ...Log })
  })
  RunGuarded(() => Telegram.startPolling(), (CaughtError) => Logger.error({ message: 'Telegram polling stopped', Error: CaughtError }))
  return {
    async Send(Destination, Content): Promise<void> {
      await Telegram.api.sendMessage({ chat_id: Destination.ExternalId, text: Content.slice(0, 4_096), ...TelegramNotificationOptions(Destination.TopicId) })
    },
    Stop(): void {
      Telegram.stop()
    }
  }
}
