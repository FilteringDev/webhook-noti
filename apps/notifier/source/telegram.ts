import { message, parseRepository, type Destination, type Language } from '@webhook-noti/core'
import TelegramBot from 'node-telegram-bot-api'
import type { NotifierDatabase } from './database.js'
import type { PlatformNotifier } from './delivery.js'

const parseCommand = (text: string): { command: string, argument: string | undefined } => {
  const [command = '', argument] = text.trim().split(/\s+/, 2)
  return { command: command.replace(/@[^\s]+$/, '').toLowerCase(), argument }
}

export const createTelegram = (token: string, database: NotifierDatabase, allowedRepositories: Set<string>): PlatformNotifier => {
  const bot = new TelegramBot(token, { polling: true })
  bot.on('message', async (update) => {
    if (update.text === undefined || update.from === undefined) return
    const { command, argument } = parseCommand(update.text)
    if (!['/subscribe', '/unsubscribe', '/language', '/dm'].includes(command)) return
    const language: Language = command === '/language'
      ? argument === 'ko' ? 'ko' : 'en'
      : database.languageFor('telegram', String(update.from.id))
    const send = async (text: string): Promise<void> => { await bot.sendMessage(update.chat.id, text, { message_thread_id: update.message_thread_id }) }
    if (command === '/language') {
      database.setLanguage('telegram', String(update.from.id), language)
      await send(message(language, 'languageSaved'))
      return
    }
    const repository = argument === undefined ? null : parseRepository(argument)
    if (repository === null) {
      await send(message(language, 'invalidRepository'))
      return
    }
    if (!allowedRepositories.has(`${repository.owner}/${repository.name}`)) {
      await send(message(language, 'repositoryDenied'))
      return
    }
    const directMessage = update.chat.type === 'private'
    if (!directMessage) {
      const administrators = await bot.getChatAdministrators(update.chat.id)
      if (!administrators.some((administrator) => administrator.user.id === update.from?.id)) {
        await send(message(language, 'forbidden'))
        return
      }
    }
    const externalId = String(update.chat.id)
    const topicId = update.message_thread_id ?? null
    if (command === '/unsubscribe') {
      await send(message(language, database.removeDestination('telegram', externalId, repository, topicId) ? 'unsubscribed' : 'failed'))
      return
    }
    const kind: Destination['kind'] = directMessage ? 'telegram-dm' : topicId === null ? 'telegram-chat' : 'telegram-topic'
    database.saveDestination({ externalId, includePrerelease: false, kind, language, ownerId: String(update.from.id), platform: 'telegram', repository, topicId })
    await send(message(language, command === '/dm' ? 'dmEnabled' : 'subscribed'))
  })
  return {
    async send(destination, content): Promise<void> {
      await bot.sendMessage(destination.externalId, content.slice(0, 4_096), destination.topicId === null ? undefined : { message_thread_id: destination.topicId })
    }
  }
}