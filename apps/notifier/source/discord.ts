import { Message, type Destination, type Repository } from '@webhook-noti/core'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, type Interaction } from 'discord.js'
import type { Dispatcher } from 'undici'
import type { NotifierDatabase } from './database.js'
import type { PlatformNotifier } from './delivery.js'
import { RepositorySelector, type RepositoryAction, type SelectionPage } from './selection.js'

const Commands = [
  new SlashCommandBuilder().setName('subscribe').setDescription('Subscribe this destination to a repository').addBooleanOption((Option) => Option.setName('prerelease').setDescription('Include prereleases')),
  new SlashCommandBuilder().setName('unsubscribe').setDescription('Unsubscribe this destination from a repository'),
  new SlashCommandBuilder().setName('language').setDescription('Set response language').addStringOption((Option) => Option.setName('value').setDescription('en or ko').setRequired(true).addChoices({ name: 'English', value: 'en' }, { name: 'Korean', value: 'ko' })),
  new SlashCommandBuilder().setName('dm').setDescription('Enable or disable direct-message releases').addBooleanOption((Option) => Option.setName('enabled').setDescription('Enable direct messages').setRequired(true))
]

function Components(Page: SelectionPage): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  const Rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`repository-select:${Page.Id}`)
      .setPlaceholder('Select a repository')
      .addOptions(Page.Repositories.map((Repository, Index) => ({ label: `${Repository.Owner}/${Repository.Name}`, value: String(Index) })))
    )
  ]
  if (Page.PageCount > 1) {
    Rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`repository-previous:${Page.Id}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(Page.Page === 0),
      new ButtonBuilder().setCustomId(`repository-next:${Page.Id}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(Page.Page === Page.PageCount - 1)
    ))
  }
  return Rows
}

export function CreateDiscord(Token: string, Database: NotifierDatabase, Repositories: Repository[], ProxyDispatcher?: Dispatcher): PlatformNotifier {
  const DiscordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    ...(ProxyDispatcher === undefined ? {} : { rest: { agent: ProxyDispatcher } })
  })
  const Selector = new RepositorySelector(Repositories)
  DiscordClient.once('ready', () => {
    void DiscordClient.application?.commands.set(Commands.map((Command) => Command.toJSON()))
  })
  DiscordClient.on('interactionCreate', (Interaction) => {
    void HandleInteraction(Interaction)
  })
  async function HandleInteraction(Interaction: Interaction): Promise<void> {
    if (Interaction.isButton() || Interaction.isStringSelectMenu()) {
      const [Operation, Id] = Interaction.customId.split(':', 2)
      if (Id === undefined || !['repository-select', 'repository-previous', 'repository-next'].includes(Operation ?? '')) return
      const ExternalId = Interaction.guildId === null ? Interaction.user.id : Interaction.channelId
      const Context = { ExternalId, IncludePrerelease: false, OwnerId: Interaction.user.id, TopicId: null }
      const Language = Database.LanguageFor('discord', Interaction.user.id)
      const IsDirectMessage = Interaction.guildId === null
      if (!(IsDirectMessage || Interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true)) {
        await Interaction.reply({ content: Message(Language, 'forbidden'), ephemeral: true })
        return
      }
      if (Operation === 'repository-previous' || Operation === 'repository-next') {
        const Page = Operation === 'repository-previous' ? Selector.Previous(Id, Context) : Selector.Next(Id, Context)
        if (Page === null) await Interaction.reply({ content: Message(Language, 'selectionExpired'), ephemeral: true })
        else await Interaction.update({ components: Components(Page) })
        return
      }
      if (!Interaction.isStringSelectMenu()) return
      const Selected = Selector.Select(Id, Context, Interaction.values[0] ?? '')
      if (Selected === null) {
        await Interaction.reply({ content: Message(Language, 'selectionExpired'), ephemeral: true })
        return
      }
      if (Selected.Action === 'unsubscribe') {
        await Interaction.update({ content: Message(Language, Database.RemoveDestination('discord', ExternalId, Selected.Repository) ? 'unsubscribed' : 'failed'), components: [] })
        return
      }
      if (Selected.Action === 'dm-disable') {
        Database.RemoveDestination('discord', ExternalId, Selected.Repository)
        await Interaction.update({ content: Message(Language, 'dmDisabled'), components: [] })
        return
      }
      const Kind: Destination['Kind'] = IsDirectMessage ? 'discord-dm' : 'discord-channel'
      Database.SaveDestination({ ExternalId, IncludePrerelease: Selected.IncludePrerelease, Kind, Language, OwnerId: Interaction.user.id, Platform: 'discord', Repository: Selected.Repository, TopicId: null })
      await Interaction.update({ content: Message(Language, Selected.Action === 'dm-enable' ? 'dmEnabled' : 'subscribed'), components: [] })
      return
    }
    if (!Interaction.isChatInputCommand()) return
    const Language = Interaction.commandName === 'language'
      ? Interaction.options.getString('value') === 'ko' ? 'ko' : 'en'
      : Database.LanguageFor('discord', Interaction.user.id)
    async function Reply(Content: string): Promise<void> {
      if (Interaction.isRepliable()) {
        await Interaction.reply({ content: Content, ephemeral: true })
      }
    }
    if (Interaction.commandName === 'language') {
      Database.SetLanguage('discord', Interaction.user.id, Language)
      await Reply(Message(Language, 'languageSaved'))
      return
    }
    const IsDirectMessage = Interaction.guildId === null
    const CanManage = IsDirectMessage || Interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true
    if (!CanManage) {
      await Reply(Message(Language, 'forbidden'))
      return
    }
    const ExternalId = IsDirectMessage ? Interaction.user.id : Interaction.channelId
    const Action: RepositoryAction = Interaction.commandName === 'unsubscribe'
      ? 'unsubscribe'
      : Interaction.commandName === 'dm' && !(Interaction.options.getBoolean('enabled') ?? true)
        ? 'dm-disable'
        : Interaction.commandName === 'dm' ? 'dm-enable' : 'subscribe'
    const Page = Selector.Create({ Action, ExternalId, IncludePrerelease: Interaction.options.getBoolean('prerelease') ?? false, OwnerId: Interaction.user.id, TopicId: null })
    await Interaction.reply({ components: Components(Page), ephemeral: true })
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
