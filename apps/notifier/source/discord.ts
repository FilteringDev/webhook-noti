import { message, parseRepository, type Destination } from '@webhook-noti/core'
import { Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'
import type { NotifierDatabase } from './database.js'
import type { PlatformNotifier } from './delivery.js'

const commands = [
  new SlashCommandBuilder().setName('subscribe').setDescription('Subscribe this destination to a repository').addStringOption((option) => option.setName('repository').setDescription('owner/repository').setRequired(true)).addBooleanOption((option) => option.setName('prerelease').setDescription('Include prereleases')),
  new SlashCommandBuilder().setName('unsubscribe').setDescription('Unsubscribe this destination from a repository').addStringOption((option) => option.setName('repository').setDescription('owner/repository').setRequired(true)),
  new SlashCommandBuilder().setName('language').setDescription('Set response language').addStringOption((option) => option.setName('value').setDescription('en or ko').setRequired(true).addChoices({ name: 'English', value: 'en' }, { name: 'Korean', value: 'ko' })),
  new SlashCommandBuilder().setName('dm').setDescription('Enable or disable direct-message releases').addBooleanOption((option) => option.setName('enabled').setDescription('Enable direct messages').setRequired(true)).addStringOption((option) => option.setName('repository').setDescription('owner/repository').setRequired(true))
]

export const createDiscord = (token: string, database: NotifierDatabase, allowedRepositories: Set<string>): PlatformNotifier => {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] })
  client.once('ready', async () => {
    await client.application?.commands.set(commands.map((command) => command.toJSON()))
  })
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return
    const language = interaction.commandName === 'language'
      ? interaction.options.getString('value') === 'ko' ? 'ko' : 'en'
      : database.languageFor('discord', interaction.user.id)
    const repositoryValue = interaction.options.getString('repository')
    const repository = repositoryValue === null ? null : parseRepository(repositoryValue)
    const reply = async (content: string): Promise<void> => { await interaction.reply({ content, ephemeral: true }) }
    if (interaction.commandName === 'language') {
      database.setLanguage('discord', interaction.user.id, language)
      await reply(message(language, 'languageSaved'))
      return
    }
    if (repository === null) {
      await reply(message(language, 'invalidRepository'))
      return
    }
    if (!allowedRepositories.has(`${repository.owner}/${repository.name}`)) {
      await reply(message(language, 'repositoryDenied'))
      return
    }
    const isDirectMessage = interaction.guildId === null
    const canManage = isDirectMessage || interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true
    if (!canManage) {
      await reply(message(language, 'forbidden'))
      return
    }
    const externalId = isDirectMessage ? interaction.user.id : interaction.channelId
    const kind: Destination['kind'] = isDirectMessage ? 'discord-dm' : 'discord-channel'
    if (interaction.commandName === 'unsubscribe') {
      await reply(message(language, database.removeDestination('discord', externalId, repository) ? 'unsubscribed' : 'failed'))
      return
    }
    if (interaction.commandName === 'dm' && !(interaction.options.getBoolean('enabled') ?? true)) {
      database.removeDestination('discord', externalId, repository)
      await reply(message(language, 'dmDisabled'))
      return
    }
    const includePrerelease = interaction.options.getBoolean('prerelease') ?? false
    database.saveDestination({ externalId, includePrerelease, kind, language, ownerId: interaction.user.id, platform: 'discord', repository, topicId: null })
    await reply(message(language, interaction.commandName === 'dm' && !(interaction.options.getBoolean('enabled') ?? true) ? 'dmDisabled' : interaction.commandName === 'dm' ? 'dmEnabled' : 'subscribed'))
  })
  void client.login(token)
  return {
    async send(destination, content): Promise<void> {
      const message = { content: content.slice(0, 2_000), allowedMentions: { parse: [] as [] } }
      if (destination.kind === 'discord-dm') {
        await (await client.users.fetch(destination.externalId)).send(message)
        return
      }
      const channel = await client.channels.fetch(destination.externalId)
      if (channel === null || !channel.isSendable()) throw new Error('Discord destination is unavailable')
      await channel.send(message)
    }
  }
}