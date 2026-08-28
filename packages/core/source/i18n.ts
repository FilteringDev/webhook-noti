import type { Language } from './types.js'

const messages = {
  en: {
    subscribed: 'Subscription saved.',
    unsubscribed: 'Subscription removed.',
    languageSaved: 'Language saved.',
    dmEnabled: 'Direct messages enabled.',
    dmDisabled: 'Direct messages disabled.',
    forbidden: 'You do not have permission to configure this destination.',
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
    repositoryDenied: '이 저장소는 허용되지 않았습니다.',
    invalidRepository: 'owner/repository 형식으로 입력하세요.',
    failed: '요청을 완료하지 못했습니다.'
  }
} as const

export type MessageKey = keyof typeof messages.en

export const message = (language: Language, key: MessageKey): string => messages[language][key]