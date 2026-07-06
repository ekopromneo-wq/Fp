import { clickFirstMatch, fillFirstMatch } from './domHelpers.js';

// #input-for-name is Zoom's real web-client field (confirmed against a live
// meeting) - it must come before the generic fallbacks, since the page also
// has a hidden #cdn_path input[type="text"] that a generic selector would
// match first.
const NAME_INPUT_SELECTORS = ['#input-for-name', 'input[placeholder*="name" i]', 'input[type="text"]'];
const JOIN_BUTTON_TEXTS = ['Join', 'Join Meeting'];
const BROWSER_JOIN_LINK_TEXTS = ['Join from Your Browser', 'join from your browser', 'Join from your Browser'];
const AUDIO_JOIN_TEXTS = ['Join Audio by Computer', 'Call using Internet Audio', 'Join with Computer Audio'];
const IN_MEETING_SELECTORS = [
  '[aria-label*="leave" i]',
  '[aria-label*="end meeting" i]',
  '.footer__leave-btn-container',
];
const WAITING_ROOM_TEXTS = [/please wait.*host will let you in/i, /waiting room/i, /waiting for the host/i];
const HARD_FAIL_TEXTS = [
  /invalid meeting id/i,
  /this meeting.*(ended|is no longer available)/i,
  /meeting.*has been ended by host/i,
  /sign in to join/i,
  /authentication.*required/i,
];
const END_TEXT_PATTERNS = [/this meeting has been ended by host/i, /meeting ended/i];

const JOIN_TIMEOUT_MS = Number(process.env.ZOOM_JOIN_TIMEOUT_MS || 10 * 60 * 1000);
const JOIN_POLL_MS = Number(process.env.ZOOM_JOIN_POLL_MS || 2000);

/**
 * Rewrites a standard Zoom link (https://<host>/j/<id>?pwd=...) to the web
 * client's direct join path (https://<host>/wc/join/<id>?pwd=...), which
 * skips Zoom's "open in desktop app" interstitial entirely and lands
 * straight on the name-entry/preview screen. Returns null when no numeric
 * meeting id can be parsed (vanity /my/<name> or webinar /w/<id> links) -
 * callers should fall back to navigating the original URL in that case.
 */
export function toWebClientJoinUrl(meetingUrl) {
  const url = new URL(meetingUrl);
  const match = url.pathname.match(/\/j\/(\d+)/);

  if (!match) {
    return null;
  }

  const pwd = url.searchParams.get('pwd');
  const webClientUrl = new URL(`/wc/join/${match[1]}`, url.origin);

  if (pwd) {
    webClientUrl.searchParams.set('pwd', pwd);
  }

  return webClientUrl.toString();
}

async function isInMeeting(page) {
  for (const selector of IN_MEETING_SELECTORS) {
    try {
      if (await page.locator(selector).first().isVisible({ timeout: 500 })) {
        return true;
      }
    } catch {
      // not present, try the next candidate
    }
  }

  return false;
}

async function getBodyText(page) {
  return page.evaluate(() => document.body.innerText).catch(() => '');
}

/**
 * Zoom's disclaimer paragraph ("By clicking 'Join', you agree to...") also
 * contains the word "Join", so a fuzzy text search for the Join button risks
 * matching that instead. Try an exact button-role match first and only fall
 * back to the fuzzy helper if that fails.
 */
async function clickJoinButton(page) {
  for (const name of JOIN_BUTTON_TEXTS) {
    try {
      const button = page.getByRole('button', { name, exact: true }).first();

      if (await button.isVisible({ timeout: 1000 })) {
        await button.click({ timeout: 2000 });
        return true;
      }
    } catch {
      // role not present yet, try the next candidate
    }
  }

  return clickFirstMatch(page, JOIN_BUTTON_TEXTS);
}

/**
 * Fallback for links that couldn't be rewritten to /wc/join (or where the
 * rewritten URL didn't actually land on a join-preview page): navigate to
 * the original meeting URL and click through Zoom's "open in desktop app"
 * interstitial via its browser-join link.
 */
async function fallbackToBrowserJoinLink(page, meetingUrl) {
  console.log('[zoom] falling back to the original URL + "join from browser" interstitial link');
  await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await clickFirstMatch(page, BROWSER_JOIN_LINK_TEXTS);
  await page.waitForTimeout(2000);
}

/**
 * Best-effort join flow for Zoom meetings. Selectors and copy are based on
 * public documentation of Zoom's web client, not verified against the real
 * live DOM - like Telemost's adapter, expect to iterate this against a real
 * test call. If the bot fails to join automatically, use the manual
 * /jobs/:id/stop endpoint to end the recording.
 */
export async function join({ page, meetingUrl, botName }) {
  const rewritten = toWebClientJoinUrl(meetingUrl);

  if (rewritten) {
    console.log(`[zoom] navigating to rewritten web-client URL ${rewritten}`);
    await page.goto(rewritten, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // domcontentloaded fires before Zoom's JS has rendered the actual join
    // form, so wait for the real name field to show up before trying to fill it.
    await page.waitForSelector(NAME_INPUT_SELECTORS[0], { timeout: 8000 }).catch(() => null);
  }

  let onJoinPage = rewritten ? await fillFirstMatch(page, NAME_INPUT_SELECTORS, botName || 'VoxMate') : false;

  if (!onJoinPage) {
    await fallbackToBrowserJoinLink(page, meetingUrl);
    onJoinPage = await fillFirstMatch(page, NAME_INPUT_SELECTORS, botName || 'VoxMate');
    console.log(`[zoom] name field ${onJoinPage ? 'found' : 'not found'} after fallback navigation`);
  }

  await page.waitForTimeout(500);

  const joined = await clickJoinButton(page);
  console.log(`[zoom] join button ${joined ? 'clicked' : 'not found (may already be past this step)'}`);

  // The "Join Audio" dialog must be dismissed for the bot's fake mic to
  // actually attach to the call's WebRTC audio mix - otherwise OS-level
  // capture would silently record silence despite looking "in" the meeting.
  await page.waitForTimeout(1500);
  await clickFirstMatch(page, AUDIO_JOIN_TEXTS);

  const deadline = Date.now() + JOIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isInMeeting(page)) {
      console.log('[zoom] confirmed in-meeting');
      return;
    }

    const bodyText = await getBodyText(page);

    if (HARD_FAIL_TEXTS.some((pattern) => pattern.test(bodyText))) {
      throw new Error(`Zoom join failed: ${bodyText.slice(0, 200)}`);
    }

    if (!WAITING_ROOM_TEXTS.some((pattern) => pattern.test(bodyText))) {
      // Not explicitly in a waiting room and not yet detected as in-meeting -
      // the audio dialog may have appeared late, so keep trying to dismiss it.
      await clickFirstMatch(page, AUDIO_JOIN_TEXTS);
    }

    await page.waitForTimeout(JOIN_POLL_MS);
  }

  throw new Error('Zoom join timed out (still in waiting room or unadmitted by the host)');
}

/**
 * Platform-specific extra signal for endDetection.js: checks whether the
 * page is showing Zoom's own "meeting ended" text. This is a secondary
 * signal - the primary ones (WebRTC state, prolonged silence) are generic
 * and live in endDetection.js.
 */
export async function matchesEndText(page) {
  const bodyText = await getBodyText(page);

  return END_TEXT_PATTERNS.some((pattern) => pattern.test(bodyText));
}
