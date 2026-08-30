# webhook-noti

GitHub App이 설치된 저장소의 release를 직접 polling해 Discord 및 Telegram에 알림을 전달하는 TypeScript 서비스입니다. inbound webhook을 수신하지 않으므로 공개 endpoint나 reverse proxy가 필요하지 않습니다.

## 시작하기

1. 알림을 받을 저장소에 notifier용 GitHub App을 설치합니다. 설치된 저장소가 곧 구독 가능한 저장소 목록이며, 별도의 허용 목록 설정은 없습니다.
2. `.env`에 GitHub App의 `GITHUB_APP_ID`를 설정하고, `secrets/` 디렉터리에 `github_app_private_key`, `globalping_api_token`, `discord_bot_token`, `telegram_bot_token` 파일을 만듭니다. 각 파일에는 해당 secret 하나만 저장합니다. 사용하지 않는 Discord 또는 Telegram 플랫폼 파일은 비워 둘 수 있습니다.
3. `chmod 600 secrets/*`로 host의 secret 파일 권한을 제한합니다. private key와 access token, bot token은 환경변수로 제공할 수 없으며 Compose가 `/run/secrets`에 mount한 파일에서만 읽습니다.
4. `docker compose up -d --build`로 시작합니다.

notifier는 60초마다 설치된 각 저장소의 release 목록을 `ETag` 조건부 요청으로 확인하고, 설치 목록 자체는 10분마다 갱신합니다. release 게시 후 알림까지 최대 1분의 지연이 발생할 수 있습니다.

Compose는 host port를 열지 않습니다. `/healthz`는 `200 ok`를 반환하며 컨테이너 health check(30초 간격, 5초 timeout, 3회 재시도)에만 사용합니다. 다른 경로는 모두 `404`입니다.

애플리케이션 로그는 발생 순서대로 한 줄에 하나의 JSON 객체 형태로 stdout에 기록됩니다. 각 레코드는 `timestamp`, `level`, `tag`, `message`, `context` 필드를 가집니다. 오류의 이름, 메시지, 스택, 원인 및 진단 속성은 보존하되 token, authorization header, password, secret, cookie, private key, API key 등 인증정보 성격의 키에 속한 값은 `[REDACTED]`로 대체합니다.

### 환경변수

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | 예 | - | notifier용 GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_FILE` | 예 (secret 파일) | - | GitHub App private key가 담긴 파일 경로 |
| `GLOBALPING_API_TOKEN_FILE` | 예 (secret 파일) | - | jsDelivr purge 검증용 Globalping API access token 파일 경로 |
| `DISCORD_BOT_TOKEN_FILE` | 아니오 (secret 파일) | - | Discord bot token 파일 경로. 비어 있으면 Discord 연동 비활성화 |
| `TELEGRAM_BOT_TOKEN_FILE` | 아니오 (secret 파일) | - | Telegram bot token 파일 경로. 비어 있으면 Telegram 연동 비활성화 |
| `PORT` | 아니오 | `3000` | health check HTTP 서버 listening port |
| `HOST` | 아니오 | `0.0.0.0` | health check HTTP 서버 bind address |
| `DATA_DIR` | 아니오 | `/var/lib/webhook-noti` | SQLite database 파일을 저장할 디렉터리 |
| `SOCKS_PROXY_URL` | 아니오 | - | GitHub REST, Discord(REST + Gateway), Telegram API 트래픽을 라우팅할 SOCKS 프록시 URL |

`GITHUB_APP_PRIVATE_KEY_FILE`, `GLOBALPING_API_TOKEN_FILE`, `DISCORD_BOT_TOKEN_FILE`, `TELEGRAM_BOT_TOKEN_FILE`은 secret의 값을 직접 담는 환경변수가 아니라, secret이 저장된 파일의 **경로**를 가리키는 환경변수입니다.

### SOCKS 프록시

`SOCKS_PROXY_URL`을 설정하면 (예: `socks5://user:pass@proxy-host:1080`) 내부적으로 로컬 ephemeral 포트에서 HTTP CONNECT bridge가 기동되어, GitHub REST API, Discord REST 및 Gateway WebSocket, Telegram API 호출을 모두 지정한 SOCKS 프록시를 통해 전달합니다. `socks`, `socks4`, `socks4a`, `socks5`, `socks5h` scheme을 지원합니다.

## GitHub App 권한

GitHub App은 알림을 받을 모든 저장소에 설치해야 합니다. Repository permissions로 Metadata Read, Contents Read, Issues Read, Actions Read/Write가 필요합니다. release 목록과 본문을 읽고, 본문의 `#123`과 `owner/repo#123`을 issue/PR로 판별하며, release의 대상 commit에서 `package.json`을 읽어 `--SubscriptionUrl` 사용 여부를 확인합니다. App에 webhook을 설정할 필요는 없습니다.

userscript repository는 release commit의 script에 `--SubscriptionUrl`이 있을 때로 판별합니다. 이 경우 notifier는 release workflow의 `Purge jsdelivr cache` job 성공을 기다립니다. job이 실패하면 해당 job만 재실행하고, 인증된 Globalping World HTTP 측정에서 Subscription URL의 HTTPS 응답이 한 곳 이상 `2xx`인지 확인한 뒤 Discord 및 Telegram으로 전달합니다. purge가 완료되지 않거나 URL 확인에 실패하면 알림은 전달하지 않습니다.

Discord bot에는 Guilds/Direct Messages intents 및 대상 채널의 View Channel, Send Messages 권한이 필요합니다. 채널 구독은 대상 채널의 `Manage Channels` 권한이 있는 사용자만 설정할 수 있습니다.

Telegram bot은 BotFather에서 그룹 privacy mode를 해제해야 command를 안정적으로 받을 수 있습니다. 그룹과 forum topic의 구독은 해당 그룹 administrator만 설정할 수 있습니다. 명령 또는 버튼 처리 중 Telegram API 전송 오류가 발생하면 notifier는 종료하지 않고 오류를 기록합니다.

Telegram polling 오류 로그에는 request 데이터 없이 `Code`, `Status`, `Detail`이 기록됩니다. `409`는 다른 `getUpdates` 클라이언트가 같은 토큰을 사용 중이라는 뜻이므로 해당 프로세스 또는 배포를 중지합니다. polling 라이브러리는 기존 webhook을 자동으로 해제하고 재시도합니다. `401`은 bot token이 올바르지 않다는 뜻이므로 `secrets/telegram_bot_token`을 교체한 뒤 서비스를 재시작합니다.

## Bot 명령어

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
- `/language en` 또는 `/language ko`
- `/dm`
- `/routes`
- `/forget`

구독 관련 명령을 실행하면 GitHub App이 설치된 저장소만 선택 목록으로 표시됩니다. 목록은 20개씩 페이지로 나뉘어 Previous/Next로 이동할 수 있으며, 선택 세션은 10분 후 만료됩니다. 사용자는 `owner/repository`를 입력할 필요가 없습니다. Discord에서 `channel`을 지정하면 선택한 저장소의 release가 해당 채널로 전송되고, 생략하면 명령을 실행한 현재 채널로 전송됩니다. Telegram command를 forum topic에서 실행하면 선택한 저장소와 해당 topic ID가 함께 저장되어 release가 그 topic으로 전송됩니다. DM에서는 명령을 실행한 본인만 자신의 DM destination을 만들 수 있습니다. `/routes`는 현재 서버(Discord) 또는 채팅(Telegram)에 등록된 활성 구독 목록을 보여줍니다.

`/forget`은 Confirm/Cancel 버튼으로 최종 확인해야 하며 확인 요청은 5분 후 만료됩니다. Discord 서버에서는 `Manage Server` 권한이, Telegram 그룹/채널에서는 administrator 권한이 필요합니다. 확인하면 현재 Discord 서버 또는 Telegram 채팅/그룹에 설정된 모든 구독과 해당 구독의 전송 이력이 즉시 삭제됩니다. Telegram forum의 모든 topic도 함께 삭제됩니다. DM에서는 현재 DM의 구독과 전송 이력, 해당 플랫폼의 언어 설정이 삭제됩니다. Discord 서버 식별자를 저장하기 시작한 뒤 생성된 구독만 서버 단위 `/forget`의 대상입니다. 그 이전의 channel-only 구독은 식별할 수 없어 유지됩니다. release 중복 방지 기록과 저장소별 polling watermark는 개인이나 알림 대상에 연결되지 않아 삭제 대상이 아닙니다.

## 안전성 및 저장소

원본 GitHub Markdown은 전송하지 않습니다. 본문은 안전한 평문으로 변환하고, `@mention`, Discord mention markup, `@everyone`, `@here`, `#channel` 형태는 zero-width separator로 재규격화합니다. Discord 전송 시에는 `allowedMentions.parse`도 빈 배열로 고정합니다. Release link는 클릭 가능한 상태로 유지하되 Discord embed와 Telegram link preview는 알림을 간결하게 표시하도록 비활성화합니다. 메시지는 3,800자에서 잘리고 release URL이 덧붙여지며, 실제 전송 시 Discord는 2,000자, Telegram은 4,096자 한도를 따릅니다.

저장소별로 마지막으로 처리한 release의 `published_at`을 watermark로 기록합니다. 저장소를 처음 관측한 시점에는 기존 release를 모두 처리 완료로만 표시하고 알림은 보내지 않으므로, App을 새로 설치해도 과거 release가 한꺼번에 전송되지 않습니다. 이후에는 watermark보다 나중에 게시된 release만, release ID 기준으로 한 번씩만 전달합니다. 일시적 전송 오류와 `429`/`5xx` 응답일 때 각 destination 전달을 `[0ms, 250ms, 1000ms]` 간격으로 최대 3회 재시도하며, 잘못된 요청, 인증/권한 오류, 찾을 수 없는 대상은 재시도하지 않습니다. 성공/실패 여부와 오류 메시지를 database에 기록합니다.

`sql.js`는 WASM SQLite database를 사용합니다. 모든 mutation 후 DB export를 `DATA_DIR`(기본값 `/var/lib/webhook-noti`) 아래 `notifier.sqlite`로 원자적으로 기록합니다. Compose의 `notifier-data` named volume만 writable이며, root filesystem은 read-only입니다. `/tmp`, `/run`은 `tmpfs`, 모든 Linux capability는 drop되고 `no-new-privileges`가 켜집니다.

## 개발

Node 24 및 pnpm 11이 필요합니다.

```sh
pnpm install --lockfile=false
pnpm lint
pnpm test
```

서비스는 TypeScript source를 `tsx`로 직접 실행합니다. 개발 중에는 `pnpm dev`, Node debugger로 실행하려면 `pnpm debug`를 사용합니다.

개발 실행도 private key와 bot token, Globalping access token은 파일 전용입니다. `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GLOBALPING_API_TOKEN_FILE`, `DISCORD_BOT_TOKEN_FILE`, `TELEGRAM_BOT_TOKEN_FILE`을 설정합니다. 필요하면 `PORT`, `HOST`, `DATA_DIR`, `SOCKS_PROXY_URL`도 함께 지정할 수 있습니다 (전체 목록은 위 [환경변수](#환경변수) 표 참고).
