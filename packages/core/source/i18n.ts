import type { Language } from './types.js'

const Messages = {
  en: {
    subscribed: 'Subscription saved.',
    unsubscribed: 'Subscription removed.',
    languageSaved: 'Language saved.',
    dmEnabled: 'Direct messages enabled.',
    dmDisabled: 'Direct messages disabled.',
    forbidden: 'You do not have permission to configure this destination.',
    routesGuildOnly: 'Routes are available only in a server.',
    routesEmpty: 'No repository routes are configured here.',
    routesHeading: 'Repository routes:',
    routesChat: 'this chat',
    routesTopic: 'topic',
    selectionExpired: 'This repository selection has expired. Run the command again.',
    repositoryDenied: 'This repository is not allowed.',
    invalidRepository: 'Use owner/repository.',
    failed: 'The request could not be completed.'
  },
  ko: {
    subscribed: '구독을 저장했습니다.',
    unsubscribed: '구독을 해제했습니다.',
    languageSaved: '언어를 저장했습니다.',
    dmEnabled: 'DM 알림을 켰습니다.',
    dmDisabled: 'DM 알림을 껐습니다.',
    forbidden: '이 대상을 설정할 권한이 없습니다.',
    routesGuildOnly: '라우팅 정보는 서버에서만 볼 수 있습니다.',
    routesEmpty: '여기에 설정된 저장소 라우팅이 없습니다.',
    routesHeading: '저장소 라우팅:',
    routesChat: '이 채팅',
    routesTopic: '토픽',
    selectionExpired: '저장소 선택이 만료되었습니다. 명령을 다시 실행하세요.',
    repositoryDenied: '이 저장소는 허용되지 않았습니다.',
    invalidRepository: 'owner/repository 형식으로 입력하세요.',
    failed: '요청을 완료하지 못했습니다.'
  }
} as const

export type MessageKey = keyof typeof Messages.en

export function Message(Language: Language, Key: MessageKey): string {
  return Messages[Language][Key]
}