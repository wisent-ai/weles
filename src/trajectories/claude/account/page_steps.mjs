// What every step of an account purchase does with a page: name the failure
// with the DOM it failed on, and click the first visible control a pattern
// names.

import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { AuthenticationFailure } from '../../_shared/subscription-auth/oauth.mjs';
import { dumpGisFailureDom } from '../google_sso/failure_dom.mjs';

/** Fail `stage` with `code`, saving the page's DOM beside the run. */
export async function failOnPage(page, code, stage, sentence) {
  const title = await page
    .title()
    .catch((error) => `(title unreadable: ${error.message})`);
  const dump = await dumpGisFailureDom(
    [{ p: page, st: { url: page.url(), title }, variant: code }],
    code,
  );
  const evidence = dump.written.length
    ? dump.written.map((entry) => entry.path).join(', ')
    : `index ${dump.indexPath}`;
  throw new AuthenticationFailure(
    code,
    stage,
    `${sentence}; page ${page.url()} titled "${title}"; DOM snapshot: ${evidence}`,
  );
}

/** Click the first visible button or link whose name matches `pattern`;
 * false when the page shows none. */
export async function clickNamed(page, pattern) {
  for (const role of ['button', 'link', 'radio', 'option']) {
    const control = page
      .getByRole(role, { name: pattern })
      .filter({ visible: true })
      .first();
    if (await control.count()) {
      await humanClickLocator(page, control);
      await pageSettled(page);
      return true;
    }
  }
  return false;
}

/** The page's visible text, for deciding which step it is at. */
export async function visibleText(page) {
  return page.evaluate(() => document.body.innerText);
}
