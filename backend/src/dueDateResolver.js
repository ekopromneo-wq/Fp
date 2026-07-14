// Deterministic relative-date resolver (US-9.3) - hand-written rather than an
// LLM call or a date-parsing dependency, same "minimum dependencies, rule-
// based where the input shape is narrow" principle as the CSV/vCard parsers
// in contacts.js and the transcript-cleanup regex from epic 6. Covers the
// patterns the story spells out explicitly (weekday references, end of
// week, within a month, relative day/week offsets, explicit dates) and
// returns null for anything else - "при неоднозначности — ?" per the
// acceptance criteria, not a best-effort guess.
//
// Word matching is done by tokenizing and exact-matching tokens against
// dictionaries of declined forms, NOT `\b...\b` regex - JS's `\b` is
// defined against ASCII `\w`, so it does not recognize boundaries around
// Cyrillic words (a whitespace-to-Cyrillic transition is "non-word to
// non-word" under that definition, i.e. never a boundary).

const WEEKDAYS = {
  'понедельник': 1, 'понедельника': 1, 'понедельнику': 1, 'понедельником': 1, 'понедельнике': 1,
  'вторник': 2, 'вторника': 2, 'вторнику': 2, 'вторником': 2, 'вторнике': 2,
  'среда': 3, 'среду': 3, 'среды': 3, 'среде': 3, 'средой': 3,
  'четверг': 4, 'четверга': 4, 'четвергу': 4, 'четвергом': 4, 'четверге': 4,
  'пятница': 5, 'пятницу': 5, 'пятницы': 5, 'пятнице': 5, 'пятницей': 5,
  'суббота': 6, 'субботу': 6, 'субботы': 6, 'субботе': 6, 'субботой': 6,
  'воскресенье': 0, 'воскресенья': 0, 'воскресенью': 0, 'воскресеньем': 0,
  'пн': 1, 'вт': 2, 'ср': 3, 'чт': 4, 'пт': 5, 'сб': 6, 'вс': 0,
};

const MONTHS = {
  'январь': 0, 'января': 0,
  'февраль': 1, 'февраля': 1,
  'март': 2, 'марта': 2,
  'апрель': 3, 'апреля': 3,
  'май': 4, 'мая': 4,
  'июнь': 5, 'июня': 5,
  'июль': 6, 'июля': 6,
  'август': 7, 'августа': 7,
  'сентябрь': 8, 'сентября': 8,
  'октябрь': 9, 'октября': 9,
  'ноябрь': 10, 'ноября': 10,
  'декабрь': 11, 'декабря': 11,
};

const DEFAULT_HOUR = 17;

function tokenize(text) {
  return text.split(/[^a-zа-яё0-9]+/i).filter(Boolean);
}

function toLocalParts(date, offsetMinutes) {
  const local = new Date(date.getTime() - offsetMinutes * 60000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    weekday: local.getUTCDay(),
  };
}

// Inverse of toLocalParts: local wall-clock fields (interpreted as UTC
// fields) plus the offset gives the real UTC instant.
function localToUtc(year, month, day, hour, minute, offsetMinutes) {
  return new Date(Date.UTC(year, month, day, hour, minute) + offsetMinutes * 60000);
}

function addDays(parts, days) {
  const base = new Date(Date.UTC(parts.year, parts.month, parts.day));
  base.setUTCDate(base.getUTCDate() + days);
  return { year: base.getUTCFullYear(), month: base.getUTCMonth(), day: base.getUTCDate(), weekday: base.getUTCDay() };
}

function nextWeekday(parts, targetWeekday) {
  let delta = (targetWeekday - parts.weekday + 7) % 7;
  if (delta === 0) {
    delta = 7; // "ближайшая пятница ПОСЛЕ встречи" - strictly after, not same day
  }
  return addDays(parts, delta);
}

function fridayOfWeek(parts) {
  // Monday-start week. If the anchor itself falls on Sat/Sun, "end of week"
  // would otherwise land in the past relative to the meeting - roll to next
  // week's Friday instead, since a due date before the meeting makes no sense.
  const mondayOffset = parts.weekday === 0 ? -6 : 1 - parts.weekday;
  const monday = addDays(parts, mondayOffset);
  const friday = addDays(monday, 4);
  const fridayIsPastOrSame =
    friday.year < parts.year ||
    (friday.year === parts.year && friday.month < parts.month) ||
    (friday.year === parts.year && friday.month === parts.month && friday.day <= parts.day);
  return fridayIsPastOrSame ? addDays(friday, 7) : friday;
}

function lastBusinessDayOfMonth(parts) {
  const lastDay = new Date(Date.UTC(parts.year, parts.month + 1, 0)).getUTCDate();
  let day = lastDay;
  let weekday = new Date(Date.UTC(parts.year, parts.month, day)).getUTCDay();
  while (weekday === 0 || weekday === 6) {
    day -= 1;
    weekday = new Date(Date.UTC(parts.year, parts.month, day)).getUTCDay();
  }
  return { year: parts.year, month: parts.month, day };
}

export function resolveDueDate(dueText, anchorDate, timezoneOffsetMinutes = 0) {
  const text = String(dueText || '').trim().toLowerCase();

  if (!text || !(anchorDate instanceof Date) || Number.isNaN(anchorDate.getTime())) {
    return null;
  }

  const offset = Number.isFinite(timezoneOffsetMinutes) ? timezoneOffsetMinutes : 0;
  const anchorParts = toLocalParts(anchorDate, offset);
  const tokens = tokenize(text);

  // Explicit date: ДД.ММ[.ГГГГ]
  const explicitMatch = text.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/);
  if (explicitMatch) {
    const day = Number(explicitMatch[1]);
    const month = Number(explicitMatch[2]) - 1;
    const year = explicitMatch[3] ? Number(explicitMatch[3].length === 2 ? `20${explicitMatch[3]}` : explicitMatch[3]) : anchorParts.year;
    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      return localToUtc(year, month, day, DEFAULT_HOUR, 0, offset);
    }
  }

  // Explicit date: "ДД <месяц>"
  for (let i = 0; i < tokens.length; i += 1) {
    if (/^\d{1,2}$/.test(tokens[i]) && tokens[i + 1] && MONTHS[tokens[i + 1]] !== undefined) {
      const day = Number(tokens[i]);
      const month = MONTHS[tokens[i + 1]];
      if (day >= 1 && day <= 31) {
        return localToUtc(anchorParts.year, month, day, DEFAULT_HOUR, 0, offset);
      }
    }
  }

  if (tokens.includes('послезавтра')) {
    const target = addDays(anchorParts, 2);
    return localToUtc(target.year, target.month, target.day, DEFAULT_HOUR, 0, offset);
  }

  if (tokens.includes('завтра')) {
    const target = addDays(anchorParts, 1);
    return localToUtc(target.year, target.month, target.day, DEFAULT_HOUR, 0, offset);
  }

  const throughIndex = tokens.indexOf('через');
  if (throughIndex !== -1 && tokens[throughIndex + 1] && tokens[throughIndex + 2]) {
    const amount = Number(tokens[throughIndex + 1]);
    const unit = tokens[throughIndex + 2];
    const isWeeks = unit.startsWith('недел');
    const isDays = unit.startsWith('д') && (unit.startsWith('ден') || unit.startsWith('дн'));

    if (Number.isFinite(amount) && amount > 0 && (isWeeks || isDays)) {
      const target = addDays(anchorParts, isWeeks ? amount * 7 : amount);
      return localToUtc(target.year, target.month, target.day, DEFAULT_HOUR, 0, offset);
    }
  }

  if (tokens.includes('месяца') && (tokens.includes('конец') || tokens.includes('конца') || tokens.includes('течение'))) {
    const target = lastBusinessDayOfMonth(anchorParts);
    return localToUtc(target.year, target.month, target.day, DEFAULT_HOUR, 0, offset);
  }

  if (tokens.includes('недели') && (tokens.includes('конец') || tokens.includes('конца'))) {
    const target = fridayOfWeek(anchorParts);
    return localToUtc(target.year, target.month, target.day, DEFAULT_HOUR, 0, offset);
  }

  for (const token of tokens) {
    if (WEEKDAYS[token] !== undefined) {
      const target = nextWeekday(anchorParts, WEEKDAYS[token]);
      return localToUtc(target.year, target.month, target.day, DEFAULT_HOUR, 0, offset);
    }
  }

  return null;
}
