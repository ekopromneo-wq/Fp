// Deterministic filler-word removal for the "Без слов-паразитов" transcript
// mode (US-6.1) - a regex list, not an LLM call, so switching modes is free
// and instant with no added cost per view. Matches whole words/phrases only
// (word boundaries), case-insensitive, so it never eats into real content.
const FILLER_PATTERNS = [
  'э-э+', 'ээ+', 'эм+', 'а-а+', 'м-м+',
  'ну', 'вот', 'короче', 'типа', 'как бы', 'в общем', 'в общем-то',
  'то есть', 'значит', 'собственно', 'собственно говоря', 'так сказать',
  'это самое', 'скажем так', 'если что',
]
  .sort((a, b) => b.length - a.length)
  .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));

const FILLER_REGEX = new RegExp(`\\b(?:${FILLER_PATTERNS.join('|')})\\b[,]?`, 'giu');

export function cleanTranscriptText(text) {
  if (!text) {
    return text;
  }

  return text
    .replace(FILLER_REGEX, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();
}
