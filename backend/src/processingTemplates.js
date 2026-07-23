// Именованные шаблоны обработки (в отличие от PROTOCOL_TEMPLATES из
// protocolTemplates.js, которые задают РАЗДЕЛЫ протокола по типу встречи, эти
// задают ОБЪЁМ результата: длину, нужны ли задачи и рекомендации). Выбирается
// при создании встречи, хранится на recordings.processing_template (null =
// дефолт аккаунта из account_config.defaultProcessingTemplate).
export const PROCESSING_TEMPLATES = {
  brief: {
    label: 'Краткий протокол',
    description: 'Только суть встречи, без списка задач.',
    length: 'brief',
    includeTasks: false,
    includeRecommendations: false,
  },
  standard: {
    label: 'Протокол + задачи',
    description: 'Протокол средней длины и извлечённые поручения.',
    length: 'medium',
    includeTasks: true,
    includeRecommendations: false,
  },
  extended: {
    label: 'Развёрнутый протокол + задачи + рекомендации',
    description: 'Подробный протокол, задачи и рекомендации по итогам встречи.',
    length: 'long',
    includeTasks: true,
    includeRecommendations: true,
  },
};

export const PROCESSING_TEMPLATE_KEYS = new Set(Object.keys(PROCESSING_TEMPLATES));

export function getProcessingTemplate(key) {
  return PROCESSING_TEMPLATES[key] || PROCESSING_TEMPLATES.standard;
}

// Разрешает эффективный шаблон: явный на записи → дефолт аккаунта → 'standard'.
export function resolveProcessingTemplateKey(recordingTemplate, accountDefaultTemplate) {
  if (recordingTemplate && PROCESSING_TEMPLATE_KEYS.has(recordingTemplate)) {
    return recordingTemplate;
  }
  if (accountDefaultTemplate && PROCESSING_TEMPLATE_KEYS.has(accountDefaultTemplate)) {
    return accountDefaultTemplate;
  }
  return 'standard';
}
