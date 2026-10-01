// Page-state capture for the claude login trajectory's failure paths. Each
// await is individually error-guarded so a closed/navigating page still
// yields a usable string instead of throwing over the real failure. Keeps
// the captured-field set identical across failure points so blobs from
// different stall points are directly comparable.
export async function pageDiag(page, { html = false } = {}) {
  const u = await Promise.resolve(page.url()).catch((x) => `url-err:${x.message}`);
  const t = await page.title().catch((x) => `title-err:${x.message}`);
  let content;
  if (html) {
    content = await page.content()
      .then((h) => h.replace(/\s+/g, ' ').slice(0, 2500))
      .catch((x) => `html-err:${x.message}`);
  } else {
    content = await page.locator('body').innerText()
      .then((b) => b.replace(/\s+/g, ' ').slice(0, 800))
      .catch((x) => `body-err:${x.message}`);
  }
  const key = html ? 'html' : 'bodyText';
  const con = Array.isArray(globalThis.__claudeConsole) ? globalThis.__claudeConsole.slice(-12) : [];
  return `url=${u} title=${JSON.stringify(t)} console=${JSON.stringify(con)} ${key}=${JSON.stringify(content)}`;
}
