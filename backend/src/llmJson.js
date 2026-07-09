export function parseJsonObject(content) {
  if (!content) {
    throw new Error('Empty LLM response');
  }

  const cleaned = content
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '');

  return JSON.parse(cleaned);
}
