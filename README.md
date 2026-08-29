# webhook-noti

A TypeScript service that polls releases in repositories where its GitHub App is installed and sends notifications to Discord and Telegram. It receives no inbound webhooks, so it needs neither a public endpoint nor a reverse proxy.

## Getting Started

1. Install the notifier GitHub App on every repository whose releases should be announced. Installed repositories are the complete list available for subscription; there is no separate allowlist.
2. Set the GitHub App's `GITHUB_APP_ID` in `.env`, then create `github_app_private_key`, `globalping_api_token`, `discord_bot_token`, and `telegram_bot_token` files in `secrets/`. Each file must contain only its corresponding secret. Files for an unused Discord or Telegram integration may be empty.
3. Restrict host-side secret-file permissions with `chmod 600 secrets/*`. Private keys, access tokens, and bot tokens cannot be supplied through environment variables; they are read only from files mounted by Compose at `/run/secrets`.
4. Start the service with `docker compose up -d --build`.

The notifier checks each installed repository's release list every 60 seconds with conditional `ETag` requests. It refreshes the installation list every 10 minutes. A release may take up to one minute to be announced after publication.

Compose exposes no host ports. `/healthz` returns `200 ok` and is used only for the container health check (30-second interval, 5-second timeout, 3 retries). Every other path returns `404`.

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | Yes | - | GitHub App ID for the notifier |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Yes (secret file) | - | Path to the file containing the GitHub App private key |
| `GLOBALPING_API_TOKEN_FILE` | Yes (secret file) | - | Path to the Globalping API access-token file used to verify jsDelivr purges |
| `DISCORD_BOT_TOKEN_FILE` | No (secret file) | - | Path to the Discord bot-token file. An empty file disables Discord integration. |
| `TELEGRAM_BOT_TOKEN_FILE` | No (secret file) | - | Path to the Telegram bot-token file. An empty file disables Telegram integration. |
| `PORT` | No | `3000` | Listening port for the health-check HTTP server |
| `HOST` | No | `0.0.0.0` | Bind address for the health-check HTTP server |
| `DATA_DIR` | No | `/var/lib/webhook-noti` | Directory where the SQLite database file is stored |
| `SOCKS_PROXY_URL` | No | - | SOCKS proxy URL for GitHub REST, Discord REST and Gateway, and Telegram API traffic |

`GITHUB_APP_PRIVATE_KEY_FILE`, `GLOBALPING_API_TOKEN_FILE`, `DISCORD_BOT_TOKEN_FILE`, and `TELEGRAM_BOT_TOKEN_FILE` are environment variables containing **paths** to secret files, not the secret values themselves.

### SOCKS Proxy

When `SOCKS_PROXY_URL` is set (for example, `socks5://user:pass@proxy-host:1080`), the service starts an internal HTTP CONNECT bridge on a local ephemeral port. GitHub REST API, Discord REST and Gateway WebSocket, and Telegram API traffic are all routed through the configured SOCKS proxy. The `socks`, `socks4`, `socks4a`, `socks5`, and `socks5h` schemes are supported.

## GitHub App Permissions

Install the GitHub App on every repository that should send notifications. It requires the following repository permissions: Metadata Read, Contents Read, Issues Read, and Actions Read/Write. The service reads release lists and bodies, determines whether `#123` and `owner/repo#123` references are issues or pull requests, and reads `package.json` at the release target commit to check for `--SubscriptionUrl`. The App does not need webhook configuration.

A repository is considered a userscript repository when the script at its release commit contains `--SubscriptionUrl`. For these repositories, the notifier waits for the release workflow's `Purge jsdelivr cache` job to succeed. If the job fails, it reruns only that job. It then uses authenticated Globalping World HTTP measurements to verify that the Subscription URL returns an HTTPS `2xx` response from at least one location before delivering to Discord and Telegram. No notification is sent if the purge does not complete or URL verification fails.

The Discord bot needs Guilds and Direct Messages intents, plus View Channel and Send Messages permissions in destination channels. Only users with Manage Channels permission for the destination channel may configure channel subscriptions.

For reliable command handling, disable group privacy mode for the Telegram bot in BotFather. Only group administrators may configure subscriptions for groups and forum topics. Telegram API transport failures during commands or button interactions are logged without stopping the notifier.

Telegram polling failures log `Code`, `Status`, and `Detail` without request data. A `409` means another `getUpdates` client is using the token; stop that process or deployment. The polling library removes a previously configured webhook and retries automatically. A `401` means the bot token is invalid; replace `secrets/telegram_bot_token` and restart the service.

## Bot Commands

Discord slash commands:

- `/subscribe channel:#channel prerelease:false`
- `/unsubscribe channel:#channel`
- `/language value:en|ko`
- `/dm enabled:true`
- `/routes`
- `/forget`

Telegram commands:

- `/subscribe`
- `/unsubscribe`
- `/language en` or `/language ko`
- `/dm`
- `/routes`
- `/forget`

Subscription commands show only repositories where the GitHub App is installed. The list is paginated in groups of 20 with Previous/Next navigation, and a selection session expires after 10 minutes. Users do not need to enter `owner/repository`. On Discord, specifying `channel` sends selected repository releases there; omitting it uses the channel where the command was run. When a Telegram command is run in a forum topic, both the selected repository and topic ID are saved, and releases are sent to that topic. In DMs, users may create destinations only for themselves. `/routes` lists active subscriptions registered in the current Discord server or Telegram chat.

`/forget` requires final confirmation with Confirm/Cancel buttons, and the confirmation request expires after five minutes. It requires Manage Server permission in a Discord server or administrator permission in a Telegram group or channel. Confirming immediately deletes all subscriptions and delivery history configured for the current Discord server or Telegram chat/group. All Telegram forum topics are also deleted. In DMs, it deletes the current DM's subscriptions, delivery history, and that platform's language setting. Only subscriptions created after Discord server identifiers began being stored are covered by server-level `/forget`; older channel-only subscriptions remain because they cannot be identified. Release deduplication records and per-repository polling watermarks are not tied to a person or destination and are not deleted.

## Safety and Storage

Original GitHub Markdown is never sent. Bodies are converted to safe plain text, and forms such as `@mention`, Discord mention markup, `@everyone`, `@here`, and `#channel` are normalized with zero-width separators. Discord messages also always set `allowedMentions.parse` to an empty array. Messages are truncated at 3,800 characters with the release URL appended; actual delivery observes Discord's 2,000-character and Telegram's 4,096-character limits.

For each repository, the notifier records the `published_at` timestamp of the most recently processed release as a watermark. On the first observation of a repository, every existing release is marked as processed without sending notifications, so installing the App does not trigger a flood of historical releases. Afterwards, only releases published after the watermark are processed, once each by release ID. Transient transport failures and `429`/`5xx` responses retry delivery to each destination up to three times at `[0ms, 250ms, 1000ms]` intervals; client, authentication, authorization, and not-found errors are recorded without retrying. Success or failure plus the error message is stored in the database.

`sql.js` provides the WASM SQLite database. After every mutation, the database is exported atomically to `notifier.sqlite` under `DATA_DIR` (default: `/var/lib/webhook-noti`). Only Compose's `notifier-data` named volume is writable; the root filesystem is read-only. `/tmp` and `/run` are `tmpfs`, all Linux capabilities are dropped, and `no-new-privileges` is enabled.

## Development

Node 24 and pnpm 11 are required.

```sh
pnpm install --lockfile=false
pnpm lint
pnpm test
```

The service runs TypeScript source directly through `tsx`. During development, use `pnpm dev`; use `pnpm debug` to run it with the Node debugger.

Development runs also require file-only private keys, bot tokens, and Globalping access tokens. Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GLOBALPING_API_TOKEN_FILE`, `DISCORD_BOT_TOKEN_FILE`, and `TELEGRAM_BOT_TOKEN_FILE`. You can also set `PORT`, `HOST`, `DATA_DIR`, and `SOCKS_PROXY_URL` as needed (see the complete [Environment Variables](#environment-variables) table above).