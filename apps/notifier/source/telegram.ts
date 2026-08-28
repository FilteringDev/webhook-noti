import { Message, ParseRepository, type Destination, type Language } from '@webhook-noti/core'
import TelegramBot from 'node-telegram-bot-api'
import type { NotifierDatabase } from './database.js'
import type { PlatformNotifier } from './delivery.js'

const ParseCommand = (Text: string): { Command: string, Argument: string | undefined } => {
  const [Command = '', Argument] = Text.trim().split(/\s+/, 2)
  return { Command: Command.replace(/@[^\s]+$/, '').toLowerCase(), Argument }
}

export const CreateTelegram = (Token: string, Database: NotifierDatabase, AllowedRepositories: Set<string>): PlatformNotifier => {
  const Bot = new TelegramBot(Token, { polling: true })
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
    const Repository = Argument === undefined ? null : ParseRepository(Argument)
    if (Repository === null) {
      await Send(Message(Language, 'invalidRepository'))
      return
    }
    if (!AllowedRepositories.has(`${Repository.Owner}/${Repository.Name}`)) {
      await Send(Message(Language, 'repositoryDenied'))
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
    if (Command === '/unsubscribe') {
      await Send(Message(Language, Database.RemoveDestination('telegram', ExternalId, Repository, TopicId) ? 'unsubscribed' : 'failed'))
      return
    }
    const Kind: Destination['Kind'] = DirectMessage ? 'telegram-dm' : TopicId === null ? 'telegram-chat' : 'telegram-topic'
    Database.SaveDestination({ ExternalId, IncludePrerelease: false, Kind, Language, OwnerId: String(Update.from.id), Platform: 'telegram', Repository, TopicId })
    await Send(Message(Language, Command === '/dm' ? 'dmEnabled' : 'subscribed'))
  })
  return {
    async Send(Destination, Content): Promise<void> {
      await Bot.sendMessage(Destination.ExternalId, Content.slice(0, 4_096), Destination.TopicId === null ? undefined : { message_thread_id: Destination.TopicId })
    }
  }
}
