import { normalize } from './plan.mjs';
import { rowAbout } from '../../_shared/page/judged/matched.mjs';
import {
  pageSettled,
  responseAfterAction,
} from '../../_shared/page/settled.mjs';

const forbidden =
  /^(prześlij do oceny|złóż|wyślij(?:\s+poprawiony)?\s+wniosek|wyślij\s+korektę|podpisz\s+i\s+wyślij|zatwierdź\s+i\s+wyślij)/i;

export async function gotoSafe(page, url, projectUrl) {
  if (url !== projectUrl && !url.startsWith(`${projectUrl}/`))
    throw new Error(`Navigation outside project: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await pageSettled(page);
  if (!page.url().startsWith(projectUrl))
    throw new Error(`Unexpected page: ${page.url()}`);
  await page.evaluate((pattern) => {
    document.addEventListener(
      'click',
      (event) => {
        const element =
          event.target instanceof Element
            ? event.target.closest(
                'button, a, [role="button"], [role="menuitem"]',
              )
            : null;
        if (
          element &&
          new RegExp(pattern, 'i').test(element.textContent.trim())
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }, forbidden.source);
}

// Some project pages (the KPW recommendations page) keep their fields behind a tab that must be opened after navigation.
export async function openScope(page, scope, projectUrl) {
  await gotoSafe(page, scope.url, projectUrl);
  if (scope.tab) {
    await clickSafe(
      page
        .getByText(scope.tab, { exact: true })
        .filter({ visible: true })
        .first(),
      scope.tab,
    );
    await pageSettled(page);
  }
}

export async function clickSafe(locator, label) {
  if (forbidden.test(label))
    throw new Error(`Refusing submission control: ${label}`);
  const page = locator.page();
  const ready = locator.and(
    page.locator(':not(:disabled):not([aria-disabled="true"])'),
  );
  await ready.waitFor({ state: 'visible' });
  await ready.dispatchEvent('click');
  await pageSettled(page);
}

export async function identity(page, projectUrl, project) {
  await gotoSafe(page, projectUrl, projectUrl);
  const body = normalize(await page.locator('body').innerText());
  const status = project.allowedStatusNeedles.find((value) =>
    body.includes(value),
  );
  if (
    !body.includes(project.applicationNumber) ||
    !body.includes(project.titleNeedle) ||
    !status
  ) {
    throw new Error(
      'Application UUID, number, title or correction status does not match the plan',
    );
  }
  return {
    projectId: project.id,
    applicationNumber: project.applicationNumber,
    status,
  };
}

export async function openRow(page, collection, row, projectUrl) {
  await gotoSafe(page, collection.url, projectUrl);
  const candidates = page
    .locator('table tbody tr')
    .filter({ has: page.locator('button[aria-label="overflow-options"]') });
  await candidates.first().waitFor({ state: 'visible' });
  // Cells are separate elements, so the model reads each row's whole visible
  // text, and judges which row the plan's subject sentence is about however the
  // row spells it.
  const texts = await candidates.evaluateAll((nodes) =>
    nodes.map((node) => node.innerText.replace(/\s+/g, ' ').trim()),
  ); // allow-raw-playwright: read-only row texts
  const index = await rowAbout(texts, row.rowSubject);
  if (index === null)
    throw new Error(
      `${collection.label}: no row is about ${row.rowSubject} (the model read ${texts.length} row(s))`,
    );
  const rows = candidates.nth(index);
  await clickSafe(
    rows.locator('button[aria-label="overflow-options"]'),
    'row menu',
  );
  await clickSafe(
    page
      .getByRole('menuitem', { name: 'Edytuj', exact: true })
      .filter({ visible: true }),
    'Edytuj',
  );
  await page.waitForFunction(
    ({ suffix, expected, equals }) => {
      // Only form controls carry a value to compare.
      const matches = Array.from(document.querySelectorAll('[name]')).filter(
        (element) =>
          typeof element.value === 'string' &&
          element.name.endsWith(suffix) &&
          element.getClientRects().length &&
          getComputedStyle(element).visibility !== 'hidden',
      );
      const norm = (value) => String(value).replace(/\s+/g, ' ').trim();
      return matches.some((element) =>
        equals
          ? norm(element.value) === norm(expected)
          : norm(element.value).includes(norm(expected)),
      );
    },
    {
      suffix: row.matchField,
      expected: row.matchNeedle,
      equals: row.matchMode === 'equals',
    },
  );
}

export async function closeDrawer(page) {
  const close = page
    .getByRole('button', { name: 'close side drawer', exact: true })
    .filter({ visible: true });
  if (await close.count()) await clickSafe(close.last(), 'close side drawer');
}

export async function save(
  page,
  collection = false,
  expected = [],
  saveButton = null,
) {
  const selector = collection
    ? '#collection-obj-form-save-btn'
    : '#section-form-save-btn';
  // The save control and the name it is refused or reported by: the named
  // button, or the form's own save button, whose label is Zapisz.
  const { button, label } = saveButton
    ? {
        button: page
          .getByRole('button', { name: saveButton, exact: true })
          .filter({ visible: true }),
        label: saveButton,
      }
    : {
        button: page.locator(selector).filter({ visible: true }),
        label: 'Zapisz',
      };
  const response = await responseAfterAction(
    page,
    (request) =>
      request.method() !== 'GET' && request.url().includes('/api/beneficiary/'),
    () => clickSafe(button, label),
  );
  const body = await response.text();
  if (!response.ok())
    throw new Error(`Save rejected: ${response.status()} ${body}`);
  const posted = response.request().postData();
  if (posted === null)
    throw new Error(`Save request to ${response.url()} carried no body`);
  const sent = JSON.stringify(JSON.parse(posted));
  const missing = expected.filter(
    (field) => !sent.includes(JSON.stringify(field.expected)),
  );
  if (missing.length)
    throw new Error(
      `Save request omitted ${missing.map((field) => field.name).join(', ')}: ${sent}`,
    );
  // The accepted response and the post-reload verification prove the save; the toast can vanish before it is observed, so it is not waited for.
  await page.waitForFunction(
    ({ selector, label }) => {
      const element = label
        ? Array.from(document.querySelectorAll('button')).find(
            (candidate) => candidate.textContent.trim() === label,
          )
        : document.querySelector(selector);
      return !element || element.disabled || !element.getClientRects().length;
    },
    { selector, label: saveButton },
  );
  if (collection) {
    await closeDrawer(page);
    const parent = page
      .locator('#section-form-save-btn')
      .filter({ visible: true });
    if ((await parent.count()) && (await parent.isEnabled())) {
      await save(page);
    }
  }
}
