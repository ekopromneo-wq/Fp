// Recording pipeline statuses, translated into plain Russian - the backend
// enum ('uploaded'/'queued'/'processing'/'transcribing'/'summarizing'/
// 'done'/'failed') is a technical value, not something to show users
// directly (US-4.1). 'processing' is kept as a legacy fallback label for
// any row still carrying the old pre-pipeline-split status value.
const RECORDING_STATUS_LABELS = {
  uploaded: 'Загружено',
  queued: 'В очереди',
  processing: 'Расшифровываем',
  transcribing: 'Расшифровываем',
  summarizing: 'Создаём протокол и задачи',
  // ADR-033: обработка отложена лимитом квоты — запись сохранена, ждёт квоты.
  waiting_quota: 'Ожидает квоты',
  done: 'Готово',
  failed: 'Ошибка',
};

export function getStatusLabel(status) {
  return RECORDING_STATUS_LABELS[status] || status;
}

export const TASK_STATUS_LABELS = {
  extracted: 'Извлечена',
  confirmed: 'Подтверждена',
  sent: 'Отправлена',
  in_progress: 'В работе',
  done: 'Готова',
  dismissed: 'Скрыта',
};

export function getTaskStatusLabel(status) {
  return TASK_STATUS_LABELS[status] || status;
}
