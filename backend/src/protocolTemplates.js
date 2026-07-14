// Fixed presets by meeting type (US-8.1) rather than a user-authored template
// builder - the spec itself defers corporate/custom templates to a later
// phase. `sections` order also drives prompt + UI + export rendering order.
// Shared by recordings.js (generation/rendering) and email.js (protocol
// dump in emails/Telegram) - kept in its own module since recordings.js
// already imports from email.js, and email.js importing back from
// recordings.js would be circular.
export const PROTOCOL_TEMPLATES = {
  planning: { label: 'Планёрка', sections: ['agenda', 'discussions', 'decisions', 'nextSteps'] },
  negotiation: { label: 'Переговоры', sections: ['participants', 'agenda', 'discussions', 'decisions', 'questions'] },
  interview: { label: 'Интервью', sections: ['participants', 'questions', 'discussions', 'nextSteps'] },
  project: { label: 'Проектная встреча', sections: ['agenda', 'discussions', 'decisions', 'risks', 'nextSteps'] },
  meeting: { label: 'Совещание', sections: ['participants', 'agenda', 'discussions', 'decisions', 'risks', 'questions', 'nextSteps'] },
  freeform: { label: 'Свои мысли', sections: ['discussions'] },
};

export const MEETING_TYPES = new Set(Object.keys(PROTOCOL_TEMPLATES));

export const PROTOCOL_ALL_SECTIONS = ['participants', 'agenda', 'discussions', 'decisions', 'risks', 'questions', 'nextSteps'];

export const PROTOCOL_SECTION_LABELS = {
  participants: 'Участники',
  agenda: 'Повестка',
  discussions: 'Обсуждения',
  decisions: 'Решения',
  risks: 'Риски',
  questions: 'Открытые вопросы',
  nextSteps: 'Следующие шаги',
};

export function getProtocolTemplate(meetingType) {
  return PROTOCOL_TEMPLATES[meetingType] || PROTOCOL_TEMPLATES.meeting;
}
