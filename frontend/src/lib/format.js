export function formatDate(value) {
  if (!value) {
    return '-';
  }

  // STG-049: было "24 июл, 14:05" - короткое название месяца неоднозначно
  // сокращает разные месяцы похоже (июн/июл/авг) и не даёт год, из-за чего
  // записи за разные годы выглядели одинаково. Числовой формат дд.мм.гггг
  // однозначен и совпадает с привычной русской нотацией дат.
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

// Русское склонение числительных: pluralizeRu(1, ['проект','проекта','проектов']).
// Возвращает только слово; число подставляйте отдельно.
export function pluralizeRu(count, [one, few, many]) {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

export function formatFileSize(bytes) {
  if (!bytes) {
    return 'без файла';
  }

  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
