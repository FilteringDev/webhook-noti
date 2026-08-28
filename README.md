# webhook-noti

GitHub `release.published` webhook을 검증하고 Discord 및 Telegram에 release 알림을 전달하는 TypeScript 서비스입니다. TLS는 이 컨테이너 앞의 reverse proxy에서 종료합니다.

## 시작하기

1. `.env.example`을 기준으로 `.env`를 만들고 `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `ALLOWED_REPOSITORIES`를 설정합니다.
2. Discord bot token 또는 Telegram bot token 중 하나 이상을 설정합니다.
3. `docker compose up -d --build`로 시작합니다.
4. reverse proxy가 notifier의 `http://notifier:3000/webhook/github`으로 전달하도록 설정합니다. GitHub webhook URL에는 proxy의 HTTPS URL을 등록하고 event는 **Releases**만 선택합니다.

Compose는 host port를 열지 않습니다. proxy와 notifier를 같은 internal Docker network에 연결해야 합니다. `/healthz`는 proxy health check에 사용할 수 있습니다.

## 필수 권한

GitHub fine-grained PAT는 `ALLOWED_REPOSITORIES`의 모든 저장소에 대해 Metadata Read 및 Issues Read가 필요합니다. PAT는 release 본문의 `#123`과 `owner/repo#123`이 issue인지 PR인지 판별할 때만 사용합니다. 조회에 실패하면 issue URL로 안전하게 대체합니다.

Discord bot에는 Guilds/Direct Messages intents 및 대상 채널의 View Channel, Send Messages 권한이 필요합니다. 채널 구독은 `Manage Channels` 권한이 있는 사용자만 설정할 수 있습니다.

Telegram bot은 BotFather에서 그룹 privacy mode를 해제해야 command를 안정적으로 받을 수 있습니다. 그룹과 forum topic의 구독은 해당 그룹 administrator만 설정할 수 있습니다.

## Bot 명령어

Discord slash commands:

- `/subscribe repository:owner/repository prerelease:false`
- `/unsubscribe repository:owner/repository`
- `/language value:en|ko`
- `/dm repository:owner/repository enabled:true`

Telegram commands:

- `/subscribe owner/repository`
- `/unsubscribe owner/repository`
- `/language en` 또는 `/language ko`
- `/dm owner/repository`

Telegram command를 forum topic에서 실행하면 해당 topic ID가 저장되어 release가 그 topic으로 전송됩니다. DM에서는 명령을 실행한 본인만 자신의 DM destination을 만들 수 있습니다.

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