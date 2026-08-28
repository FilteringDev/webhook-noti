import { Message, ParseRepository, type Destination } from '@webhook-noti/core'
import { Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder, type Interaction } from 'discord.js'
import type { NotifierDatabase } from './database.js'
import type { PlatformNotifier } from './delivery.js'

const Commands = [
  new SlashCommandBuilder().setName('subscribe').setDescription('Subscribe this destination to a repository').addStringOption((Option) => Option.setName('repository').setDescription('owner/repository').setRequired(true)).addBooleanOption((Option) => Option.setName('prerelease').setDescription('Include prereleases')),
  new SlashCommandBuilder().setName('unsubscribe').setDescription('Unsubscribe this destination from a repository').addStringOption((Option) => Option.setName('repository').setDescription('owner/repository').setRequired(true)),
  new SlashCommandBuilder().setName('language').setDescription('Set response language').addStringOption((Option) => Option.setName('value').setDescription('en or ko').setRequired(true).addChoices({ name: 'English', value: 'en' }, { name: 'Korean', value: 'ko' })),
  new SlashCommandBuilder().setName('dm').setDescription('Enable or disable direct-message releases').addBooleanOption((Option) => Option.setName('enabled').setDescription('Enable direct messages').setRequired(true)).addStringOption((Option) => Option.setName('repository').setDescription('owner/repository').setRequired(true))
]

export const CreateDiscord = (Token: string, Database: NotifierDatabase, AllowedRepositories: Set<string>): PlatformNotifier => {
  const DiscordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] })
  DiscordClient.once('ready', () => {
    void DiscordClient.application?.commands.set(Commands.map((Command) => Command.toJSON()))
  })
  DiscordClient.on('interactionCreate', (Interaction) => {
    void HandleInteraction(Interaction)
  })
  const HandleInteraction = async (Interaction: Interaction): Promise<void> => {
    if (!Interaction.isChatInputCommand()) return
    const Language = Interaction.commandName === 'language'
      ? Interaction.options.getString('value') === 'ko' ? 'ko' : 'en'
      : Database.LanguageFor('discord', Interaction.user.id)
    const RepositoryValue = Interaction.options.getString('repository')
    const Repository = RepositoryValue === null ? null : ParseRepository(RepositoryValue)
    const Reply = async (Content: string): Promise<void> => { await Interaction.reply({ content: Content, ephemeral: true }) }
    if (Interaction.commandName === 'language') {
      Database.SetLanguage('discord', Interaction.user.id, Language)
      await Reply(Message(Language, 'languageSaved'))
      return
    }
    if (Repository === null) {
      await Reply(Message(Language, 'invalidRepository'))
      return
    }
    if (!AllowedRepositories.has(`${Repository.Owner}/${Repository.Name}`)) {
      await Reply(Message(Language, 'repositoryDenied'))
      return
    }
    const IsDirectMessage = Interaction.guildId === null
    const CanManage = IsDirectMessage || Interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true
    if (!CanManage) {
      await Reply(Message(Language, 'forbidden'))
      return
    }
    const ExternalId = IsDirectMessage ? Interaction.user.id : Interaction.channelId
    const Kind: Destination['Kind'] = IsDirectMessage ? 'discord-dm' : 'discord-channel'
    if (Interaction.commandName === 'unsubscribe') {
      await Reply(Message(Language, Database.RemoveDestination('discord', ExternalId, Repository) ? 'unsubscribed' : 'failed'))
      return
    }
    if (Interaction.commandName === 'dm' && !(Interaction.options.getBoolean('enabled') ?? true)) {
      Database.RemoveDestination('discord', ExternalId, Repository)
      await Reply(Message(Language, 'dmDisabled'))
      return
    }
    const IncludePrerelease = Interaction.options.getBoolean('prerelease') ?? false
    Database.SaveDestination({ ExternalId, IncludePrerelease, Kind, Language, OwnerId: Interaction.user.id, Platform: 'discord', Repository, TopicId: null })
    await Reply(Message(Language, Interaction.commandName === 'dm' && !(Interaction.options.getBoolean('enabled') ?? true) ? 'dmDisabled' : Interaction.commandName === 'dm' ? 'dmEnabled' : 'subscribed'))
  }
  void DiscordClient.login(Token)
  return {
    async Send(Destination, Content): Promise<void> {
      const Payload = { content: Content.slice(0, 2_000), allowedMentions: { parse: [] as [] } }
      if (Destination.Kind === 'discord-dm') {
        await (await DiscordClient.users.fetch(Destination.ExternalId)).send(Payload)
        return
      }
      const Channel = await DiscordClient.channels.fetch(Destination.ExternalId)
      if (Channel === null || !Channel.isSendable()) throw new Error('Discord destination is unavailable')
      await Channel.send(Payload)
    }
  }
}
