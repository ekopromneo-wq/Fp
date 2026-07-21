export async function clickFirstMatch(page, texts) {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: false }).first();

    try {
      if (await locator.isVisible({ timeout: 1000 })) {
        await locator.click({ timeout: 2000 });
        return true;
      }
    } catch {
      // selector not present yet, try the next candidate
    }
  }

  return false;
}

export async function fillFirstMatch(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      if (await locator.isVisible({ timeout: 1000 })) {
        await locator.fill(value);
        return true;
      }
    } catch {
      // selector not present yet, try the next candidate
    }
  }

  return false;
}

/**
 * US-15.1: общая логика объявления о записи в чате конференции — открыть панель
 * чата, найти поле ввода (textarea или contenteditable), ввести сообщение и
 * отправить (Enter). Best-effort: всегда возвращает boolean, никогда не бросает,
 * чтобы отчёт о записи не мог сорвать саму запись.
 */
export async function announceViaChat(page, message, toggleSelectors, inputSelectors, toggleTexts = []) {
  try {
    let opened = false;

    for (const selector of toggleSelectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 1000 })) {
          await locator.click({ timeout: 2000 });
          opened = true;
          break;
        }
      } catch {
        // try the next candidate
      }
    }

    if (!opened && toggleTexts.length) {
      opened = await clickFirstMatch(page, toggleTexts);
    }

    // Панель могла быть уже открыта — пробуем ввод независимо от opened.
    await page.waitForTimeout(800);

    for (const selector of inputSelectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 1000 })) {
          await locator.click({ timeout: 1500 });
          // contenteditable иногда не поддерживает fill — падаем на посимвольный ввод.
          await locator.fill(message).catch(async () => {
            await locator.type(message);
          });
          await page.keyboard.press('Enter');
          return true;
        }
      } catch {
        // try the next candidate
      }
    }

    return false;
  } catch {
    return false;
  }
}
