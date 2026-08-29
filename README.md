# webhook-noti

GitHub `release.published` webhook을 검증하고 Discord 및 Telegram에 release 알림을 전달하는 TypeScript 서비스입니다. TLS는 이 컨테이너 앞의 reverse proxy에서 종료합니다.

## 시작하기

1. `.env.example`을 기준으로 `.env`를 만들고 `ALLOWED_REPOSITORIES`에 배포에서 허용할 `owner/repository` 목록만 설정합니다. 이 목록 밖의 webhook과 구독은 거부됩니다.
2. `.env`에 GitHub App의 `GITHUB_APP_ID`를 설정하고, `secrets/` 디렉터리에 `github_app_private_key`, `github_webhook_secret`, `discord_bot_token`, `telegram_bot_token` 파일을 만듭니다. 각 파일에는 해당 secret 하나만 저장합니다. 사용하지 않는 Discord 또는 Telegram 플랫폼 파일은 비워 둘 수 있습니다.
3. `chmod 600 secrets/*`로 host의 secret 파일 권한을 제한합니다. access token, webhook secret, bot token은 환경변수로 제공할 수 없으며 Compose가 `/run/secrets`에 mount한 파일에서만 읽습니다.
4. `docker compose up -d --build`로 시작합니다.
5. reverse proxy가 notifier의 `http://notifier:3000/webhook/github`으로 전달하도록 설정합니다. GitHub webhook URL에는 proxy의 HTTPS URL을 등록하고 event는 **Releases**만 선택합니다.

Compose는 host port를 열지 않습니다. proxy와 notifier를 같은 internal Docker network에 연결해야 합니다. `/healthz`는 `200 ok`를 반환하며 proxy 및 컨테이너 health check(30초 간격, 5초 timeout, 3회 재시도)에 사용할 수 있습니다.

### 환경변수

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `ALLOWED_REPOSITORIES` | 예 | - | webhook 수신과 구독을 허용할 `owner/repository` 목록 (comma-separated) |
| `GITHUB_APP_ID` | 예 | - | notifier용 GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_FILE` | 예 (secret 파일) | - | GitHub App private key가 담긴 파일 경로 |
| `GITHUB_WEBHOOK_SECRET_FILE` | 예 (secret 파일) | - | GitHub webhook 서명 검증에 쓰이는 secret 파일 경로 |
| `DISCORD_BOT_TOKEN_FILE` | 아니오 (secret 파일) | - | Discord bot token 파일 경로. 비어 있으면 Discord 연동 비활성화 |
| `TELEGRAM_BOT_TOKEN_FILE` | 아니오 (secret 파일) | - | Telegram bot token 파일 경로. 비어 있으면 Telegram 연동 비활성화 |
| `PORT` | 아니오 | `3000` | HTTP 서버 listening port |
| `HOST` | 아니오 | `0.0.0.0` | HTTP 서버 bind address |
| `WEBHOOK_PATH` | 아니오 | `/webhook/github` | GitHub webhook을 수신할 경로 (`/`로 시작해야 함) |
| `DATA_DIR` | 아니오 | `/var/lib/webhook-noti` | SQLite database 파일을 저장할 디렉터리 |
| `SOCKS_PROXY_URL` | 아니오 | - | GitHub REST, Discord(REST + Gateway), Telegram API 트래픽을 라우팅할 SOCKS 프록시 URL |

`GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_WEBHOOK_SECRET_FILE`, `DISCORD_BOT_TOKEN_FILE`, `TELEGRAM_BOT_TOKEN_FILE`은 secret의 값을 직접 담는 환경변수가 아니라, secret이 저장된 파일의 **경로**를 가리키는 환경변수입니다.

### SOCKS 프록시

`SOCKS_PROXY_URL`을 설정하면 (예: `socks5://user:pass@proxy-host:1080`) 내부적으로 로컬 ephemeral 포트에서 HTTP CONNECT bridge가 기동되어, GitHub REST API, Discord REST 및 Gateway WebSocket, Telegram API 호출을 모두 지정한 SOCKS 프록시를 통해 전달합니다. `socks`, `socks4`, `socks4a`, `socks5`, `socks5h` scheme을 지원합니다.

## GitHub App 권한

GitHub App은 `ALLOWED_REPOSITORIES`의 모든 저장소에 설치되어야 합니다. Repository permissions로 Metadata Read, Contents Read, Issues Read, Actions Read/Write가 필요합니다. release 본문의 `#123`과 `owner/repo#123`을 issue/PR로 판별하고, release의 대상 commit에서 `package.json`을 읽어 `--SubscriptionUrl` 사용 여부를 확인합니다.

userscript repository는 release commit의 script에 `--SubscriptionUrl`이 있을 때로 판별합니다. 이 경우 notifier는 release workflow의 `Purge jsdelivr cache` job 성공을 기다립니다. job이 실패하면 해당 job만 재실행하고, `@typescriptprime/securereq`로 Subscription URL의 HTTPS 응답을 확인한 뒤 Discord 및 Telegram으로 전달합니다. purge가 완료되지 않거나 URL 확인에 실패하면 알림은 전달하지 않습니다.

Discord bot에는 Guilds/Direct Messages intents 및 대상 채널의 View Channel, Send Messages 권한이 필요합니다. 채널 구독은 대상 채널의 `Manage Channels` 권한이 있는 사용자만 설정할 수 있습니다.

Telegram bot은 BotFather에서 그룹 privacy mode를 해제해야 command를 안정적으로 받을 수 있습니다. 그룹과 forum topic의 구독은 해당 그룹 administrator만 설정할 수 있습니다.

## Bot 명령어

Discord slash commands:

- `/subscribe channel:#channel prerelease:false`
- `/unsubscribe channel:#channel`
- `/language value:en|ko`
- `/dm enabled:true`
- `/routes`

Telegram commands:

- `/subscribe`
- `/unsubscribe`
- `/language en` 또는 `/language ko`
- `/dm`
- `/routes`

구독 관련 명령을 실행하면 deployment의 `ALLOWED_REPOSITORIES`에 있는 저장소만 선택 목록으로 표시됩니다. 목록은 20개씩 페이지로 나뉘어 Previous/Next로 이동할 수 있으며, 선택 세션은 10분 후 만료됩니다. 사용자는 `owner/repository`를 입력할 필요가 없습니다. Discord에서 `channel`을 지정하면 선택한 저장소의 release가 해당 채널로 전송되고, 생략하면 명령을 실행한 현재 채널로 전송됩니다. Telegram command를 forum topic에서 실행하면 선택한 저장소와 해당 topic ID가 함께 저장되어 release가 그 topic으로 전송됩니다. DM에서는 명령을 실행한 본인만 자신의 DM destination을 만들 수 있습니다. `/routes`는 현재 서버(Discord) 또는 채팅(Telegram)에 등록된 활성 구독 목록을 보여줍니다.

## 안전성 및 저장소

원본 GitHub Markdown은 전송하지 않습니다. 본문은 안전한 평문으로 변환하고, `@mention`, Discord mention markup, `@everyone`, `@here`, `#channel` 형태는 zero-width separator로 재규격화합니다. Discord 전송 시에는 `allowedMentions.parse`도 빈 배열로 고정합니다. 메시지는 3,800자에서 잘리고 release URL이 덧붙여지며, 실제 전송 시 Discord는 2,000자, Telegram은 4,096자 한도를 따릅니다.

webhook payload는 최대 1 MiB까지만 허용하고, HMAC-SHA256 서명이 일치하지 않으면 거부합니다. `x-github-delivery` 헤더로 중복 전송을 감지해 이미 처리한 delivery는 재처리 없이 202를 반환합니다. 각 destination으로의 전달은 실패 시 `[0ms, 250ms, 1000ms]` 간격으로 최대 3회 재시도하며, 성공/실패 여부와 오류 메시지를 database에 기록합니다.

`sql.js`는 WASM SQLite database를 사용합니다. 모든 mutation 후 DB export를 `DATA_DIR`(기본값 `/var/lib/webhook-noti`) 아래 `notifier.sqlite`로 원자적으로 기록합니다. Compose의 `notifier-data` named volume만 writable이며, root filesystem은 read-only입니다. `/tmp`, `/run`은 `tmpfs`, 모든 Linux capability는 drop되고 `no-new-privileges`가 켜집니다.

## 개발

Node 24 및 pnpm 11이 필요합니다.

```sh
pnpm install --lockfile=false
pnpm lint
pnpm test
```

서비스는 TypeScript source를 `tsx`로 직접 실행합니다. 개발 중에는 `pnpm dev`, Node debugger로 실행하려면 `pnpm debug`를 사용합니다.

개발 실행도 private key와 bot token, webhook secret은 파일 전용입니다. `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_WEBHOOK_SECRET_FILE`, `DISCORD_BOT_TOKEN_FILE`, `TELEGRAM_BOT_TOKEN_FILE`을 설정하고, `ALLOWED_REPOSITORIES`를 함께 제공합니다. 필요하면 `PORT`, `HOST`, `WEBHOOK_PATH`, `DATA_DIR`, `SOCKS_PROXY_URL`도 함께 지정할 수 있습니다 (전체 목록은 위 [환경변수](#환경변수) 표 참고).