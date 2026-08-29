import { Message, type Destination, type Language, type Repository } from '@webhook-noti/core'
import { consola } from 'consola'
import { HttpsProxyAgent } from 'https-proxy-agent'
import TelegramBot from 'node-telegram-bot-api'
import { RunGuarded } from './async-guard.js'
import type { NotifierDatabase } from './database.js'
import type { PlatformNotifier } from './delivery.js'
import { ForgetConfirmation, type ForgetScope } from './forget.js'
import { RepositorySelector, type SelectionPage } from './selection.js'

const Logger = consola.withTag('telegram')

function ParseCommand(Text: string): { Command: string, Argument: string | undefined } {
  const [Command = '', Argument] = Text.trim().split(/\s+/, 2)
  return { Command: Command.replace(/@[^\s]+$/, '').toLowerCase(), Argument }
}

function Keyboard(Page: SelectionPage): TelegramBot.InlineKeyboardMarkup {
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

function ForgetKeyboard(Id: string, Language: Language): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: Message(Language, 'forgetConfirm'), callback_data: `forget-confirm:${Id}` },
      { text: Message(Language, 'forgetCancel'), callback_data: `forget-cancel:${Id}` }
    ]]
  }
}

export function CreateTelegram(Token: string, Database: NotifierDatabase, ListRepositories: () => Repository[], ProxyUrl?: string): PlatformNotifier {
  // @types/request's `Options` union requires a `url`/`uri` field that a bare `agent` override never needs.
  const RequestOptions = ProxyUrl === undefined ? undefined : { agent: new HttpsProxyAgent(ProxyUrl) } as unknown as TelegramBot.ConstructorOptions['request']
  const Bot = new TelegramBot(Token, {
    polling: true,
    ...(RequestOptions === undefined ? {} : { request: RequestOptions })
  })
  const Selector = new RepositorySelector(ListRepositories)
  const ForgetConfirmations = new ForgetConfirmation()
  Bot.on('message', (Update) => {
    RunGuarded(async () => {
    if (Update.text === undefined || Update.from === undefined) return
    const { Command, Argument } = ParseCommand(Update.text)
    if (!['/subscribe', '/unsubscribe', '/language', '/dm', '/routes', '/forget'].includes(Command)) return
    const Language: Language = Command === '/language'
      ? Argument === 'ko' ? 'ko' : 'en'
      : Database.LanguageFor('telegram', String(Update.from.id))
    async function Send(Text: string): Promise<void> {
      await Bot.sendMessage(Update.chat.id, Text, { message_thread_id: Update.message_thread_id })
    }
    if (Command === '/language') {
      Database.SetLanguage('telegram', String(Update.from.id), Language)
      await Send(Message(Language, 'languageSaved'))
      return
    }
    const DirectMessage = Update.chat.type === 'private'
    if (Command === '/forget') {
      if (!DirectMessage) {
        const Administrators = await Bot.getChatAdministrators(Update.chat.id)
        if (!Administrators.some((Administrator) => Administrator.user.id === Update.from?.id)) {
          await Send(Message(Language, 'forbidden'))
          return
        }
      }
      const ExternalId = String(Update.chat.id)
      const Scope: ForgetScope = DirectMessage
        ? { Platform: 'telegram', Type: 'dm', ExternalId }
        : { Platform: 'telegram', Type: 'chat', ExternalId }
      const Id = ForgetConfirmations.Create(String(Update.from.id), ExternalId, Scope)
      await Bot.sendMessage(Update.chat.id, Message(Language, DirectMessage ? 'forgetDmWarning' : 'forgetChatWarning'), { message_thread_id: Update.message_thread_id, reply_markup: ForgetKeyboard(Id, Language) })
      return
    }
    if (!DirectMessage) {
      const Administrators = await Bot.getChatAdministrators(Update.chat.id)
      if (!Administrators.some((Administrator) => Administrator.user.id === Update.from?.id)) {
        await Send(Message(Language, 'forbidden'))
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
      await Bot.sendMessage(Update.chat.id, 'Select a repository.', { message_thread_id: TopicId ?? undefined, reply_markup: Keyboard(Page) })
    }, (CaughtError) => Logger.error({ message: 'Telegram message handler failed', Error: CaughtError }))
  })
  Bot.on('callback_query', (Callback) => {
    RunGuarded(async () => {
    if (Callback.message === undefined || Callback.data === undefined) return
    const [Operation, Id, Index] = Callback.data.split(':', 3)
    if (Operation === 'forget-confirm' || Operation === 'forget-cancel') {
      const MessageValue = Callback.message
      const ExternalId = String(MessageValue.chat.id)
      const Language = Database.LanguageFor('telegram', String(Callback.from.id))
      if (Operation === 'forget-confirm' && MessageValue.chat.type !== 'private') {
        const Administrators = await Bot.getChatAdministrators(MessageValue.chat.id)
        if (!Administrators.some((Administrator) => Administrator.user.id === Callback.from.id)) {
          await Bot.answerCallbackQuery(Callback.id, { text: Message(Language, 'forbidden'), show_alert: true })
          return
        }
      }
      const Scope = Id === undefined ? null : ForgetConfirmations.Take(Id, String(Callback.from.id), ExternalId)
      if (Scope === null || Scope.Platform !== 'telegram') await Bot.editMessageText(Message(Language, 'forgetExpired'), { chat_id: MessageValue.chat.id, message_id: MessageValue.message_id })
      else if (Operation === 'forget-cancel') await Bot.editMessageText(Message(Language, 'forgetCancelled'), { chat_id: MessageValue.chat.id, message_id: MessageValue.message_id })
      else {
        if (Scope.Type === 'dm') Database.ForgetDirectMessage('telegram', Scope.ExternalId)
        else Database.ForgetTelegramChat(Scope.ExternalId)
        await Bot.editMessageText(Message(Language, 'forgotten'), { chat_id: MessageValue.chat.id, message_id: MessageValue.message_id })
      }
      await Bot.answerCallbackQuery(Callback.id)
      return
    }
    if (Id === undefined || !['repository-select', 'repository-previous', 'repository-next'].includes(Operation ?? '')) return
    const MessageValue = Callback.message
    const ExternalId = String(MessageValue.chat.id)
    const TopicId = MessageValue.message_thread_id ?? null
    const Context = { OwnerId: String(Callback.from.id), SourceId: ExternalId, TopicId }
    const Language = Database.LanguageFor('telegram', String(Callback.from.id))
    const DirectMessage = MessageValue.chat.type === 'private'
    if (!DirectMessage) {
      const Administrators = await Bot.getChatAdministrators(MessageValue.chat.id)
      if (!Administrators.some((Administrator) => Administrator.user.id === Callback.from.id)) {
        await Bot.answerCallbackQuery(Callback.id, { text: Message(Language, 'forbidden'), show_alert: true })
        return
      }
    }
    if (Operation === 'repository-previous' || Operation === 'repository-next') {
      const Page = Operation === 'repository-previous' ? Selector.Previous(Id, Context) : Selector.Next(Id, Context)
      if (Page === null) await Bot.answerCallbackQuery(Callback.id, { text: Message(Language, 'selectionExpired'), show_alert: true })
      else {
        await Bot.editMessageReplyMarkup(Keyboard(Page), { chat_id: MessageValue.chat.id, message_id: MessageValue.message_id })
        await Bot.answerCallbackQuery(Callback.id)
      }
      return
    }
    const Selected = Selector.Select(Id, Context, Index ?? '')
    if (Selected === null) {
      await Bot.answerCallbackQuery(Callback.id, { text: Message(Language, 'selectionExpired'), show_alert: true })
      return
    }
    let Result: Parameters<typeof Message>[1]
    if (Selected.Action === 'unsubscribe') Result = Database.RemoveDestination('telegram', Selected.ExternalId, Selected.Repository, Selected.TopicId) ? 'unsubscribed' : 'failed'
    else {
      const Kind: Destination['Kind'] = DirectMessage ? 'telegram-dm' : Selected.TopicId === null ? 'telegram-chat' : 'telegram-topic'
      Database.SaveDestination({ ExternalId: Selected.ExternalId, GuildId: null, IncludePrerelease: Selected.IncludePrerelease, Kind, Language, OwnerId: String(Callback.from.id), Platform: 'telegram', Repository: Selected.Repository, TopicId: Selected.TopicId })
      Result = Selected.Action === 'dm-enable' ? 'dmEnabled' : 'subscribed'
    }
    await Bot.editMessageText(Message(Language, Result), { chat_id: MessageValue.chat.id, message_id: MessageValue.message_id })
      await Bot.answerCallbackQuery(Callback.id)
    }, (CaughtError) => Logger.error({ message: 'Telegram callback query handler failed', Error: CaughtError }))
  })
  Bot.on('polling_error', (CaughtError) => Logger.error({ message: 'Telegram polling failed', Error: CaughtError }))
  return {
    async Send(Destination, Content): Promise<void> {
      await Bot.sendMessage(Destination.ExternalId, Content.slice(0, 4_096), Destination.TopicId === null ? undefined : { message_thread_id: Destination.TopicId })
    }
  }
}
