# webhook-noti

GitHub `release.published` webhook을 검증하고 Discord 및 Telegram에 release 알림을 전달하는 TypeScript 서비스입니다. TLS는 이 컨테이너 앞의 reverse proxy에서 종료합니다.

## 시작하기

1. `.env.example`을 기준으로 `.env`를 만들고 `ALLOWED_REPOSITORIES`에 배포에서 허용할 `owner/repository` 목록만 설정합니다. 이 목록 밖의 webhook과 구독은 거부됩니다.
2. `secrets/` 디렉터리에 `github_token`, `github_webhook_secret`, `discord_bot_token`, `telegram_bot_token` 파일을 만듭니다. 각 파일에는 해당 secret 하나만 저장합니다. 사용하지 않는 Discord 또는 Telegram 플랫폼 파일은 비워 둘 수 있습니다.
3. `chmod 600 secrets/*`로 host의 secret 파일 권한을 제한합니다. access token, webhook secret, bot token은 환경변수로 제공할 수 없으며 Compose가 `/run/secrets`에 mount한 파일에서만 읽습니다.
4. `docker compose up -d --build`로 시작합니다.
5. reverse proxy가 notifier의 `http://notifier:3000/webhook/github`으로 전달하도록 설정합니다. GitHub webhook URL에는 proxy의 HTTPS URL을 등록하고 event는 **Releases**만 선택합니다.

Compose는 host port를 열지 않습니다. proxy와 notifier를 같은 internal Docker network에 연결해야 합니다. `/healthz`는 proxy health check에 사용할 수 있습니다.

## 필수 권한

GitHub fine-grained PAT는 `ALLOWED_REPOSITORIES`의 모든 저장소에 대해 Metadata Read 및 Issues Read가 필요합니다. PAT는 release 본문의 `#123`과 `owner/repo#123`이 issue인지 PR인지 판별할 때만 사용합니다. 조회에 실패하면 issue URL로 안전하게 대체합니다.

Discord bot에는 Guilds/Direct Messages intents 및 대상 채널의 View Channel, Send Messages 권한이 필요합니다. 채널 구독은 `Manage Channels` 권한이 있는 사용자만 설정할 수 있습니다.

Telegram bot은 BotFather에서 그룹 privacy mode를 해제해야 command를 안정적으로 받을 수 있습니다. 그룹과 forum topic의 구독은 해당 그룹 administrator만 설정할 수 있습니다.

## Bot 명령어

Discord slash commands:

- `/subscribe prerelease:false`
- `/unsubscribe`
- `/language value:en|ko`
- `/dm enabled:true`

Telegram commands:

- `/subscribe`
- `/unsubscribe`
- `/language en` 또는 `/language ko`
- `/dm`

구독 관련 명령을 실행하면 deployment의 `ALLOWED_REPOSITORIES`에 있는 저장소만 선택 목록으로 표시됩니다. 목록이 길면 Previous/Next로 이동할 수 있으며, 사용자는 `owner/repository`를 입력할 필요가 없습니다. Telegram command를 forum topic에서 실행하면 해당 topic ID가 저장되어 release가 그 topic으로 전송됩니다. DM에서는 명령을 실행한 본인만 자신의 DM destination을 만들 수 있습니다.

## 안전성 및 저장소

원본 GitHub Markdown은 전송하지 않습니다. 본문은 안전한 평문으로 변환하고, `@mention`, Discord mention markup, `@everyone`, `@here`, `#channel` 형태는 zero-width separator로 재규격화합니다. Discord 전송 시에는 `allowedMentions.parse`도 빈 배열로 고정합니다.

`sql.js`는 WASM SQLite database를 사용합니다. 모든 mutation 후 DB export를 `/var/lib/webhook-noti/notifier.sqlite`로 원자적으로 기록합니다. Compose의 `notifier-data` named volume만 writable이며, root filesystem은 read-only입니다. `/tmp`, `/run`은 `tmpfs`, 모든 Linux capability는 drop되고 `no-new-privileges`가 켜집니다.

## 개발

Node 24 및 pnpm 11이 필요합니다.

```sh
pnpm install --lockfile=false
pnpm lint
pnpm test
```

서비스는 TypeScript source를 `tsx`로 직접 실행합니다. 개발 중에는 `pnpm dev`, Node debugger로 실행하려면 `pnpm debug`를 사용합니다.

개발 실행도 secret 파일 전용입니다. `GITHUB_TOKEN_FILE`, `GITHUB_WEBHOOK_SECRET_FILE`, `DISCORD_BOT_TOKEN_FILE`, `TELEGRAM_BOT_TOKEN_FILE`에 각각 local secret 파일 경로를 지정하고, `ALLOWED_REPOSITORIES`를 함께 제공합니다.