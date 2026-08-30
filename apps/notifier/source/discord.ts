import { Message, type Destination, type Repository } from '@webhook-noti/core'
import { consola } from 'consola'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder, type GuildMember, type Interaction } from 'discord.js'
import type { Dispatcher } from 'undici'
import { RunGuarded } from './async-guard.js'
import type { NotifierDatabase } from './database.js'
import type { PlatformNotifier } from './delivery.js'
import { ReplyWithFailure } from './discord-response.js'
import { ForgetConfirmation, type ForgetScope } from './forget.js'
import { RepositorySelector, type RepositoryAction, type SelectionPage } from './selection.js'

const Logger = consola.withTag('discord')

const Commands = [
  new SlashCommandBuilder().setName('subscribe').setDescription('Subscribe this destination to a repository').addChannelOption((Option) => Option.setName('channel').setDescription('Channel to receive release notifications')).addBooleanOption((Option) => Option.setName('prerelease').setDescription('Include prereleases')),
  new SlashCommandBuilder().setName('unsubscribe').setDescription('Unsubscribe this destination from a repository').addChannelOption((Option) => Option.setName('channel').setDescription('Channel to remove release notifications from')),
  new SlashCommandBuilder().setName('language').setDescription('Set response language').addStringOption((Option) => Option.setName('value').setDescription('en or ko').setRequired(true).addChoices({ name: 'English', value: 'en' }, { name: 'Korean', value: 'ko' })),
  new SlashCommandBuilder().setName('dm').setDescription('Enable or disable direct-message releases').addBooleanOption((Option) => Option.setName('enabled').setDescription('Enable direct messages').setRequired(true)),
  new SlashCommandBuilder().setName('routes').setDescription('Show repository notification routes in this server'),
  new SlashCommandBuilder().setName('forget').setDescription('Delete stored data for this server or direct message')
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

function ForgetComponents(Id: string, Language: Destination['Language']): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`forget-confirm:${Id}`).setLabel(Message(Language, 'forgetConfirm')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`forget-cancel:${Id}`).setLabel(Message(Language, 'forgetCancel')).setStyle(ButtonStyle.Secondary)
  )
}

export function CreateDiscord(Token: string, Database: NotifierDatabase, ListRepositories: () => Repository[], ProxyDispatcher?: Dispatcher): PlatformNotifier {
  const DiscordClient = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    ...(ProxyDispatcher === undefined ? {} : { rest: { agent: ProxyDispatcher } })
  })
  const Selector = new RepositorySelector(ListRepositories)
  const ForgetConfirmations = new ForgetConfirmation()
  DiscordClient.once(Events.ClientReady, () => {
    void DiscordClient.application?.commands.set(Commands.map((Command) => Command.toJSON()))
  })
  DiscordClient.on('interactionCreate', (Interaction) => {
    RunGuarded(() => HandleInteraction(Interaction), (CaughtError) => {
      Logger.error({ message: 'Discord interaction handler failed', Error: CaughtError })
      RunGuarded(() => ReplyInteractionFailure(Interaction), (RecoveryError) => Logger.error({ message: 'Discord interaction failure response failed', Error: RecoveryError }))
    })
  })
  async function ReplyInteractionFailure(Interaction: Interaction): Promise<void> {
    if (!Interaction.isRepliable() || Interaction.replied) return
    const Content = Message(Database.LanguageFor('discord', Interaction.user.id), 'failed')
    await ReplyWithFailure({
      Deferred: Interaction.deferred,
      Replied: Interaction.replied,
      EditReply: async (ReplyContent) => { await Interaction.editReply({ content: ReplyContent, components: [] }) },
      Reply: async (ReplyContent) => { await Interaction.reply({ content: ReplyContent, flags: MessageFlags.Ephemeral }) }
    }, Content)
  }
  async function HandleInteraction(Interaction: Interaction): Promise<void> {
    if (Interaction.isButton() && (Interaction.customId.startsWith('forget-confirm:') || Interaction.customId.startsWith('forget-cancel:'))) {
      const [Operation, Id] = Interaction.customId.split(':', 2)
      const Language = Database.LanguageFor('discord', Interaction.user.id)
      const SourceId = Interaction.guildId ?? Interaction.user.id
      if (Operation === 'forget-confirm' && Interaction.guildId !== null && Interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) !== true) {
        await Interaction.reply({ content: Message(Language, 'forbidden'), flags: MessageFlags.Ephemeral })
        return
      }
      const Scope = Id === undefined ? null : ForgetConfirmations.Take(Id, Interaction.user.id, SourceId)
      if (Scope === null) {
        await Interaction.update({ content: Message(Language, 'forgetExpired'), components: [] })
        return
      }
      if (Operation === 'forget-cancel') {
        await Interaction.update({ content: Message(Language, 'forgetCancelled'), components: [] })
        return
      }
      if (Scope.Type === 'guild') Database.ForgetDiscordGuild(Scope.GuildId)
      else Database.ForgetDirectMessage('discord', Scope.ExternalId)
      await Interaction.update({ content: Message(Language, 'forgotten'), components: [] })
      return
    }
    if (Interaction.isButton() || Interaction.isStringSelectMenu()) {
      const [Operation, Id] = Interaction.customId.split(':', 2)
      if (Id === undefined || !['repository-select', 'repository-previous', 'repository-next'].includes(Operation ?? '')) return
      const SourceId = Interaction.guildId === null ? Interaction.user.id : Interaction.channelId
      const Context = { OwnerId: Interaction.user.id, SourceId, TopicId: null }
      const Language = Database.LanguageFor('discord', Interaction.user.id)
      const IsDirectMessage = Interaction.guildId === null
      if (!(IsDirectMessage || Interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true)) {
        await Interaction.reply({ content: Message(Language, 'forbidden'), flags: MessageFlags.Ephemeral })
        return
      }
      if (Operation === 'repository-previous' || Operation === 'repository-next') {
        const Page = Operation === 'repository-previous' ? Selector.Previous(Id, Context) : Selector.Next(Id, Context)
        if (Page === null) await Interaction.reply({ content: Message(Language, 'selectionExpired'), flags: MessageFlags.Ephemeral })
        else await Interaction.update({ components: Components(Page) })
        return
      }
      if (!Interaction.isStringSelectMenu()) return
      const Selected = Selector.Select(Id, Context, Interaction.values[0] ?? '')
      if (Selected === null) {
        await Interaction.reply({ content: Message(Language, 'selectionExpired'), flags: MessageFlags.Ephemeral })
        return
      }
      if (Selected.Action === 'unsubscribe') {
        await Interaction.update({ content: Message(Language, Database.RemoveDestination('discord', Selected.ExternalId, Selected.Repository, Selected.TopicId) ? 'unsubscribed' : 'failed'), components: [] })
        return
      }
      if (Selected.Action === 'dm-disable') {
        Database.RemoveDestination('discord', Selected.ExternalId, Selected.Repository, Selected.TopicId)
        await Interaction.update({ content: Message(Language, 'dmDisabled'), components: [] })
        return
      }
      const Kind: Destination['Kind'] = IsDirectMessage ? 'discord-dm' : 'discord-channel'
      Database.SaveDestination({ ExternalId: Selected.ExternalId, GuildId: Interaction.guildId, IncludePrerelease: Selected.IncludePrerelease, Kind, Language, OwnerId: Interaction.user.id, Platform: 'discord', Repository: Selected.Repository, TopicId: Selected.TopicId })
      await Interaction.update({ content: Message(Language, Selected.Action === 'dm-enable' ? 'dmEnabled' : 'subscribed'), components: [] })
      return
    }
    if (!Interaction.isChatInputCommand()) return
    const Language = Interaction.commandName === 'language'
      ? Interaction.options.getString('value') === 'ko' ? 'ko' : 'en'
      : Database.LanguageFor('discord', Interaction.user.id)
    async function Reply(Content: string): Promise<void> {
      if (Interaction.isRepliable()) {
        if (Interaction.deferred) await Interaction.editReply({ content: Content, components: [] })
        else await Interaction.reply({ content: Content, flags: MessageFlags.Ephemeral })
      }
    }
    if (Interaction.commandName === 'language') {
      Database.SetLanguage('discord', Interaction.user.id, Language)
      await Reply(Message(Language, 'languageSaved'))
      return
    }
    const IsDirectMessage = Interaction.guildId === null
    if (Interaction.commandName === 'forget') {
      if (!IsDirectMessage && Interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) !== true) {
        await Reply(Message(Language, 'forbidden'))
        return
      }
      const SourceId = Interaction.guildId ?? Interaction.user.id
      const Scope: ForgetScope = Interaction.guildId === null
        ? { Platform: 'discord', Type: 'dm', ExternalId: Interaction.user.id }
        : { Platform: 'discord', Type: 'guild', GuildId: Interaction.guildId }
      const Id = ForgetConfirmations.Create(Interaction.user.id, SourceId, Scope)
      await Interaction.reply({ content: Message(Language, IsDirectMessage ? 'forgetDmWarning' : 'forgetGuildWarning'), components: [ForgetComponents(Id, Language)], flags: MessageFlags.Ephemeral })
      return
    }
    const CanManage = IsDirectMessage || Interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true
    if (!CanManage) {
      await Reply(Message(Language, 'forbidden'))
      return
    }
    const RequiresRemoteLookup = Interaction.commandName === 'routes' || Interaction.commandName === 'subscribe' || Interaction.commandName === 'unsubscribe'
    if (RequiresRemoteLookup) await Interaction.deferReply({ flags: MessageFlags.Ephemeral })
    if (Interaction.commandName === 'routes') {
      if (Interaction.guild === null) {
        await Reply(Message(Language, 'routesGuildOnly'))
        return
      }
      const Channels = await Interaction.guild.channels.fetch()
      const Routes = Database.RoutesFor('discord', [...Channels.keys()])
      const Content = Routes.length === 0
        ? Message(Language, 'routesEmpty')
        : [Message(Language, 'routesHeading'), ...Routes.map((Route) => `${Route.Repository.Owner}/${Route.Repository.Name} -> <#${Route.ExternalId}>`)].join('\n')
      await Reply(Content.slice(0, 2_000))
      return
    }
    const TargetChannel = Interaction.commandName === 'subscribe' || Interaction.commandName === 'unsubscribe' ? Interaction.options.getChannel('channel') : null
    const ExternalId = IsDirectMessage ? Interaction.user.id : TargetChannel?.id ?? Interaction.channelId
    if (!IsDirectMessage) {
      const Channel = await DiscordClient.channels.fetch(ExternalId)
      if (Channel === null || !Channel.isSendable()) {
        await Reply(Message(Language, 'failed'))
        return
      }
      const HasPermission = ExternalId === Interaction.channelId
        ? Interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true
        : 'permissionsFor' in Channel && Interaction.member !== null && Channel.permissionsFor(Interaction.member as GuildMember)?.has(PermissionFlagsBits.ManageChannels) === true
      if (!HasPermission) {
        await Reply(Message(Language, 'forbidden'))
        return
      }
    }
    const Action: RepositoryAction = Interaction.commandName === 'unsubscribe'
      ? 'unsubscribe'
      : Interaction.commandName === 'dm' && !(Interaction.options.getBoolean('enabled') ?? true)
        ? 'dm-disable'
        : Interaction.commandName === 'dm' ? 'dm-enable' : 'subscribe'
    const SourceId = IsDirectMessage ? Interaction.user.id : Interaction.channelId
    const Page = Selector.Create({ Action, ExternalId, IncludePrerelease: Interaction.options.getBoolean('prerelease') ?? false, OwnerId: Interaction.user.id, SourceId, TopicId: null })
    if (Page.Repositories.length === 0) {
      await Reply(Message(Language, 'routesEmpty'))
      return
    }
    if (Interaction.deferred) await Interaction.editReply({ content: '', components: Components(Page) })
    else await Interaction.reply({ components: Components(Page), flags: MessageFlags.Ephemeral })
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
