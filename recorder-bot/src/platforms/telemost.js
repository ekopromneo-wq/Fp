import { clickFirstMatch, fillFirstMatch, announceViaChat } from './domHelpers.js';

const JOIN_BUTTON_TEXTS = ['Присоединиться', 'Войти', 'Подключиться', 'Join'];
const NAME_INPUT_SELECTORS = ['input[type="text"]', 'input[placeholder*="мя" i]', 'input[placeholder*="name" i]'];
const END_TEXT_PATTERNS = [/звонок заверш/i, /встреча заверш/i, /call ended/i, /meeting ended/i];
// US-15.1 (e): признаки удаления/исключения бота из встречи.
const REMOVED_TEXT_PATTERNS = [
  /вас удалил/i,
  /вас исключил/i,
  /вы были удалены/i,
  /you (have )?(been )?removed/i,
  /removed from the (call|meeting)/i,
];
const CHAT_TOGGLE_SELECTORS = [
  'button[aria-label*="чат" i]',
  'button[aria-label*="chat" i]',
  '[data-testid*="chat" i]',
];
const CHAT_INPUT_SELECTORS = [
  'textarea[placeholder*="сообщени" i]',
  'textarea[placeholder*="message" i]',
  'div[contenteditable="true"]',
  'textarea',
];

/**
 * Best-effort join flow for Yandex Telemost's guest-link UI. Selectors are
 * not guaranteed stable across Telemost releases - if the bot fails to join
 * automatically, use the manual /jobs/:id/stop endpoint to end the
 * recording and adjust these selectors against the real DOM.
 */
export async function join({ page, meetingUrl, botName }) {
  console.log(`[telemost] navigating to ${meetingUrl}`);
  await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await page.waitForTimeout(2000);
  await fillFirstMatch(page, NAME_INPUT_SELECTORS, botName || 'Бот-ассистент');
  await page.waitForTimeout(500);

  const joined = await clickFirstMatch(page, JOIN_BUTTON_TEXTS);
  console.log(`[telemost] join button ${joined ? 'clicked' : 'not found (may already be in the call)'}`);

  await page.waitForTimeout(3000);
}

/**
 * US-15.1: бот объявляет о записи в чате Телемоста (best-effort, см. announceViaChat).
 */
export async function announce({ page, message }) {
  return announceViaChat(page, message, CHAT_TOGGLE_SELECTORS, CHAT_INPUT_SELECTORS, ['Чат', 'Chat']);
}

/**
 * Platform-specific extra signal for endDetection.js: checks whether the
 * page is showing Telemost's own "call ended" text. This is a secondary
 * signal - the primary ones (WebRTC state, prolonged silence) are generic
 * and live in endDetection.js.
 */
export async function matchesEndText(page) {
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

  return END_TEXT_PATTERNS.some((pattern) => pattern.test(bodyText));
}

/**
 * US-15.1 (e): распознаёт удаление/исключение бота из встречи Телемоста.
 */
export async function matchesRemovedText(page) {
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

  return REMOVED_TEXT_PATTERNS.some((pattern) => pattern.test(bodyText));
}
