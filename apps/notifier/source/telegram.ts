import { Message, type Destination, type Language, type Repository } from '@webhook-noti/core'
import TelegramBot from 'node-telegram-bot-api'
import type { NotifierDatabase } from './database.js'
import type { PlatformNotifier } from './delivery.js'
import { RepositorySelector, type SelectionPage } from './selection.js'

const ParseCommand = (Text: string): { Command: string, Argument: string | undefined } => {
  const [Command = '', Argument] = Text.trim().split(/\s+/, 2)
  return { Command: Command.replace(/@[^\s]+$/, '').toLowerCase(), Argument }
}

const Keyboard = (Page: SelectionPage): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    ...Page.Repositories.map((Repository, Index) => [{ text: `${Repository.Owner}/${Repository.Name}`, callback_data: `repository-select:${Page.Id}:${Index}` }]),
    ...(Page.PageCount > 1 ? [[
      { text: 'Previous', callback_data: `repository-previous:${Page.Id}` },
      { text: 'Next', callback_data: `repository-next:${Page.Id}` }
    ]] : [])
  ]
})

export const CreateTelegram = (Token: string, Database: NotifierDatabase, Repositories: Repository[]): PlatformNotifier => {
  const Bot = new TelegramBot(Token, { polling: true })
  const Selector = new RepositorySelector(Repositories)
  Bot.on('message', async (Update) => {
    if (Update.text === undefined || Update.from === undefined) return
    const { Command, Argument } = ParseCommand(Update.text)
    if (!['/subscribe', '/unsubscribe', '/language', '/dm'].includes(Command)) return
    const Language: Language = Command === '/language'
      ? Argument === 'ko' ? 'ko' : 'en'
      : Database.LanguageFor('telegram', String(Update.from.id))
    const Send = async (Text: string): Promise<void> => { await Bot.sendMessage(Update.chat.id, Text, { message_thread_id: Update.message_thread_id }) }
    if (Command === '/language') {
      Database.SetLanguage('telegram', String(Update.from.id), Language)
      await Send(Message(Language, 'languageSaved'))
      return
    }
    const DirectMessage = Update.chat.type === 'private'
    if (!DirectMessage) {
      const Administrators = await Bot.getChatAdministrators(Update.chat.id)
      if (!Administrators.some((Administrator) => Administrator.user.id === Update.from?.id)) {
        await Send(Message(Language, 'forbidden'))
        return
      }
    }
    const ExternalId = String(Update.chat.id)
    const TopicId = Update.message_thread_id ?? null
    const Action = Command === '/unsubscribe' ? 'unsubscribe' : Command === '/dm' ? 'dm-enable' : 'subscribe'
    const Page = Selector.Create({ Action, ExternalId, IncludePrerelease: false, OwnerId: String(Update.from.id), TopicId })
    await Bot.sendMessage(Update.chat.id, 'Select a repository.', { message_thread_id: TopicId ?? undefined, reply_markup: Keyboard(Page) })
  })
  Bot.on('callback_query', async (Callback) => {
    if (Callback.message === undefined || Callback.data === undefined) return
    const [Operation, Id, Index] = Callback.data.split(':', 3)
    if (Id === undefined || !['repository-select', 'repository-previous', 'repository-next'].includes(Operation ?? '')) return
    const MessageValue = Callback.message
    const ExternalId = String(MessageValue.chat.id)
    const TopicId = MessageValue.message_thread_id ?? null
    const Context = { ExternalId, IncludePrerelease: false, OwnerId: String(Callback.from.id), TopicId }
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
    if (Selected.Action === 'unsubscribe') Result = Database.RemoveDestination('telegram', ExternalId, Selected.Repository, TopicId) ? 'unsubscribed' : 'failed'
    else {
      const Kind: Destination['Kind'] = DirectMessage ? 'telegram-dm' : TopicId === null ? 'telegram-chat' : 'telegram-topic'
      Database.SaveDestination({ ExternalId, IncludePrerelease: Selected.IncludePrerelease, Kind, Language, OwnerId: String(Callback.from.id), Platform: 'telegram', Repository: Selected.Repository, TopicId })
      Result = Selected.Action === 'dm-enable' ? 'dmEnabled' : 'subscribed'
    }
    await Bot.editMessageText(Message(Language, Result), { chat_id: MessageValue.chat.id, message_id: MessageValue.message_id })
    await Bot.answerCallbackQuery(Callback.id)
  })
  return {
    async Send(Destination, Content): Promise<void> {
      await Bot.sendMessage(Destination.ExternalId, Content.slice(0, 4_096), Destination.TopicId === null ? undefined : { message_thread_id: Destination.TopicId })
    }
  }
}
