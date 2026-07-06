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
