// Applies or verifies one declared NCBR correction plan through the visible LSI UI.
// The trajectory never submits, signs, withdraws, or sends an application.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LSI_ORIGIN = 'https://lsi2.ncbr.gov.pl';
const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const mode = process.env.NCBR_CORRECTION_MODE || 'verify';
const rawPlan = process.env.NCBR_CORRECTION_PLAN || '';
const runId = process.env.WELES_RUN_ID || `ncbr-correction-${new Date().toISOString().replace(/[:.]/g, '-')}`;
process.env.WELES_RUN_ID = runId;

if (!['apply', 'verify'].includes(mode)) throw new Error(`unsupported NCBR_CORRECTION_MODE: ${mode}`);
if (!rawPlan || rawPlan.length > 100_000) throw new Error('NCBR_CORRECTION_PLAN must contain 1-100000 characters');

const plan = JSON.parse(rawPlan);
const reportDir = runRecordingsDir(`ncbr_${mode}_correction`);
const reportPath = `${reportDir}/correction-report.json`;
const results = [];
let submissionClicked = false;

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function fieldEvidence(scope, name, value, persisted = true) {
  return { scope, name, length: String(value).length, sha256: sha256(value), persisted };
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertPlannedField(field, label) {
  assertObject(field, label);
  if (typeof field.name !== 'string' && typeof field.nameSuffix !== 'string') {
    throw new Error(`${label} requires name or nameSuffix`);
  }
  if (typeof field.value !== 'string') throw new Error(`${label}.value must be a string`);
  if (!Number.isInteger(field.maxLength) || field.maxLength < 1) throw new Error(`${label}.maxLength must be positive`);
  if (field.value.length > field.maxLength) {
    throw new Error(`${label} has ${field.value.length} characters, limit ${field.maxLength}`);
  }
}

function validatePlan() {
  assertObject(plan, 'plan');
  if (plan.schema !== 'weles.ncbr.correction-plan.v1') throw new Error(`unsupported correction schema: ${plan.schema}`);
  assertObject(plan.project, 'project');
  if (!/^[0-9a-f-]{36}$/.test(plan.project.id || '')) throw new Error('invalid project id');
  if (typeof plan.project.applicationNumber !== 'string' || !plan.project.applicationNumber) throw new Error('application number is required');
  if (typeof plan.project.titleNeedle !== 'string' || !plan.project.titleNeedle) throw new Error('project title needle is required');
  if (plan.project.neverSubmit !== true) throw new Error('correction plan must set neverSubmit=true');
  if (!Array.isArray(plan.project.allowedStatusNeedles) || plan.project.allowedStatusNeedles.length === 0) {
    throw new Error('at least one allowed correction status is required');
  }
  const deadline = Date.parse(plan.project.deadline);
  if (!Number.isFinite(deadline)) throw new Error('invalid correction deadline');
  if (mode === 'apply' && Date.now() > deadline) throw new Error('correction deadline has passed');
  if (!Array.isArray(plan.sections) || !Array.isArray(plan.collections)) throw new Error('sections and collections must be arrays');

  const seen = new Set();
  for (const section of plan.sections) {
    assertObject(section, `section ${section?.label || '?'}`);
    if (!String(section.url || '').startsWith(`${LSI_ORIGIN}/projekt/${plan.project.id}/projekt_step/`)) {
      throw new Error(`unsafe section URL: ${section.url}`);
    }
    for (const field of section.fields || []) {
      assertPlannedField(field, `${section.label}.${field?.name || '?'}`);
      const key = `${section.id}:${field.name}`;
      if (seen.has(key)) throw new Error(`duplicate field plan: ${key}`);
      seen.add(key);
    }
  }

  for (const collection of plan.collections) {
    if (!String(collection.url || '').startsWith(`${LSI_ORIGIN}/projekt/${plan.project.id}/projekt_step/`)) {
      throw new Error(`unsafe collection URL: ${collection.url}`);
    }
    for (const [rowIndex, row] of (collection.rows || []).entries()) {
      if (typeof row.rowNeedle !== 'string' || !row.rowNeedle) throw new Error(`${collection.label} row ${rowIndex} requires rowNeedle`);
      if (typeof row.matchField !== 'string' || typeof row.matchNeedle !== 'string') {
        throw new Error(`${collection.label} row ${rowIndex} requires matchField and matchNeedle`);
      }
      for (const field of row.fields || []) assertPlannedField(field, `${collection.label}.${field?.name || '?'}`);
      if (row.nested) {
        if (typeof row.nested.matchFieldSuffix !== 'string' || typeof row.nested.matchNeedle !== 'string') {
          throw new Error(`${collection.label} nested selector is incomplete`);
        }
        for (const field of row.nested.fields || []) assertPlannedField(field, `${collection.label}.nested.${field?.nameSuffix || '?'}`);
      }
    }
  }

  assertObject(plan.correctionCard, 'correctionCard');
  if (plan.correctionCard.criterionNumber !== 2) throw new Error('this trajectory accepts criterion 2 only');
  assertPlannedField({ name: 'criterion-2-answer', ...plan.correctionCard }, 'correctionCard');
}

validatePlan();

const projectUrl = `${LSI_ORIGIN}/projekt/${plan.project.id}`;
const forbiddenSubmission = /^(złóż|wyślij(?:\s+poprawiony)?\s+wniosek|wyślij\s+korektę|podpisz\s+i\s+wyślij|zatwierdź\s+i\s+wyślij)/i;

async function installSubmissionGuard(page) {
  await page.evaluate((source) => {
    const pattern = new RegExp(source, 'i');
    window.__welesNcbrBlockedSubmissionClicks = [];
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('button, a, [role="button"], [role="menuitem"]') : null;
      const text = (target?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || !pattern.test(text)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.__welesNcbrBlockedSubmissionClicks.push(text.slice(0, 160));
    }, true);
  }, forbiddenSubmission.source); // allow-raw-playwright: install a capture-phase guard against final submission controls
}

async function neutralizeCookieOverlay(page) {
  await page.evaluate(() => {
    const node = Array.from(document.querySelectorAll('div')).find((item) => (item.innerText || '').includes('pliki cookies'));
    if (node) node.style.pointerEvents = 'none';
  }); // allow-raw-playwright: neutralise only the cookie overlay
}

async function gotoSafe(page, url) {
  if (!url.startsWith(`${projectUrl}`)) throw new Error(`navigation outside declared project: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 }); // allow-raw-playwright: navigate only inside the declared LSI project
  await humanIdlePause('long');
  if (page.url().includes('/logowanie')) throw new Error('LSI session is not authenticated');
  if (!page.url().startsWith(`${projectUrl}`)) throw new Error(`unexpected navigation target: ${page.url()}`);
  await installSubmissionGuard(page);
  await neutralizeCookieOverlay(page);
  await page.waitForSelector('textarea, input, table, button, a', { timeout: 30_000 }).catch(() => {}); // allow-raw-playwright: wait for rendered LSI controls
}

async function projectIdentity(page) {
  await gotoSafe(page, projectUrl);
  const identity = await page.evaluate(({ titleNeedle, applicationNumber, statuses }) => {
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const controls = Array.from(document.querySelectorAll('button, a')).map((item) => ({
      text: (item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      href: item instanceof HTMLAnchorElement ? item.href : '',
    })).filter((item) => item.text);
    return {
      hasTitle: body.includes(titleNeedle),
      hasApplicationNumber: body.includes(applicationNumber),
      status: statuses.find((status) => body.includes(status)) || null,
      controls: controls.slice(0, 120),
    };
  }, {
    titleNeedle: plan.project.titleNeedle,
    applicationNumber: plan.project.applicationNumber,
    statuses: plan.project.allowedStatusNeedles,
  }); // allow-raw-playwright: read project identity and correction status before any write
  if (!identity.hasTitle) throw new Error('declared project title is not visible');
  if (!identity.status) throw new Error('project is not in a declared correction status');
  results.push({ scope: 'project', projectId: plan.project.id, applicationNumber: plan.project.applicationNumber, applicationNumberVisible: identity.hasApplicationNumber, status: identity.status });
  return identity;
}

function suffixLocator(page, suffix) {
  return page.locator(`[name$="${suffix}"]`);
}

async function oneField(page, suffix) {
  const visible = suffixLocator(page, suffix).filter({ visible: true });
  if (await visible.count() > 0) return visible.last();
  const all = suffixLocator(page, suffix);
  if (await all.count() !== 1) throw new Error(`field selector ${suffix} resolved to ${await all.count()} controls`);
  return all.first();
}

async function assertFieldCapacity(locator, field, scope, requireEditable = false) {
  await locator.waitFor({ state: 'visible', timeout: 30_000 });
  const state = await locator.evaluate((element) => ({
    disabled: Boolean(element.disabled),
    readOnly: Boolean(element.readOnly),
    maxLength: Number(element.getAttribute('maxlength') || 0),
    name: element.getAttribute('name') || '',
  })); // allow-raw-playwright: inspect declared field mutability and browser limit
  if (requireEditable && (state.disabled || state.readOnly)) throw new Error(`${scope}.${field.name || field.nameSuffix} is locked`);
  const effectiveMax = state.maxLength || field.maxLength;
  if (field.value.length > effectiveMax) {
    throw new Error(`${scope}.${field.name || field.nameSuffix} has ${field.value.length} characters, UI limit ${effectiveMax}`);
  }
  return state;
}

async function fillField(locator, field, scope) {
  await assertFieldCapacity(locator, field, scope, true);
  await locator.fill(field.value); // allow-raw-playwright: fill one declared correction field through the visible control
  await locator.dispatchEvent('blur'); // allow-raw-playwright: commit the visible React-controlled field value
  await humanIdlePause('short');
  const current = await locator.inputValue();
  if (current !== field.value) throw new Error(`${scope}.${field.name || field.nameSuffix} did not retain the exact value before save`);
}

async function readField(locator, field, scope) {
  await assertFieldCapacity(locator, field, scope);
  const actual = await locator.inputValue();
  if (actual !== field.value) {
    throw new Error(`${scope}.${field.name || field.nameSuffix} mismatch: expected ${field.value.length}/${sha256(field.value)}, actual ${actual.length}/${sha256(actual)}`);
  }
  return fieldEvidence(scope, field.name || field.nameSuffix, actual);
}

async function clickExactSafe(page, role, text) {
  if (forbiddenSubmission.test(normalize(text))) throw new Error(`refusing forbidden control: ${text}`);
  const locator = page.getByRole(role, { name: text, exact: true });
  const visible = locator.filter({ visible: true });
  if (await visible.count() === 0) throw new Error(`visible ${role} not found: ${text}`);
  await visible.last().click(); // allow-raw-playwright: click an exact, non-submission LSI control
  await humanIdlePause('deliberate');
}

async function saveVisibleForm(page) {
  await clickExactSafe(page, 'button', 'Zapisz');
  await humanIdlePause('long');
}

async function closeVisibleForm(page) {
  const cancel = page.getByRole('button', { name: 'Anuluj', exact: true }).filter({ visible: true });
  if (await cancel.count() > 0) {
    await cancel.last().click(); // allow-raw-playwright: close a row form without any submission action
    await humanIdlePause('long');
  }
}

async function applyScalarSection(page, section) {
  await gotoSafe(page, section.url);
  if (mode === 'apply') {
    for (const field of section.fields) await fillField(await oneField(page, field.name), field, section.label);
    await saveVisibleForm(page);
  }
  await gotoSafe(page, section.url);
  for (const field of section.fields) results.push(await readField(await oneField(page, field.name), field, section.label));
}

async function openCollectionRow(page, collection, row) {
  await gotoSafe(page, collection.url);
  const found = await page.evaluate((needle) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const matches = Array.from(document.querySelectorAll('table tbody tr')).filter((candidate) => {
      if (!candidate.querySelector('button[aria-label="overflow-options"]')) return false;
      const cells = Array.from(candidate.querySelectorAll('td')).map((cell) => `${cell.getAttribute('title') || ''} ${cell.textContent || ''}`).join(' ');
      return norm(cells).includes(needle);
    });
    if (matches.length !== 1) return { count: matches.length };
    matches[0].querySelector('button[aria-label="overflow-options"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { count: 1 };
  }, row.rowNeedle); // allow-raw-playwright: open the one table row named by the correction plan
  if (found.count !== 1) throw new Error(`${collection.label} row needle resolved to ${found.count}: ${row.rowNeedle}`);
  await humanIdlePause('deliberate');
  await clickExactSafe(page, 'menuitem', 'Edytuj');
  await page.waitForSelector(`[name$="${row.matchField}"]`, { timeout: 30_000 }); // allow-raw-playwright: wait for the selected row form
  const match = await (await oneField(page, row.matchField)).inputValue();
  const matches = row.matchMode === 'equals' ? normalize(match) === normalize(row.matchNeedle) : normalize(match).includes(normalize(row.matchNeedle));
  if (!matches) throw new Error(`${collection.label} opened the wrong row`);
}

async function nestedPrefix(page, nested) {
  const candidates = suffixLocator(page, nested.matchFieldSuffix);
  const count = await candidates.count();
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const locator = candidates.nth(index);
    const value = await locator.inputValue();
    if (normalize(value).includes(normalize(nested.matchNeedle))) {
      const name = await locator.getAttribute('name');
      matches.push(name.slice(0, -nested.matchFieldSuffix.length));
    }
  }
  if (matches.length !== 1) throw new Error(`nested selector resolved to ${matches.length}: ${nested.matchNeedle}`);
  return matches[0];
}

async function applyCollectionRow(page, collection, row) {
  await openCollectionRow(page, collection, row);
  if (mode === 'apply') {
    for (const field of row.fields || []) await fillField(await oneField(page, field.name), field, collection.label);
    if (row.nested) {
      const prefix = await nestedPrefix(page, row.nested);
      for (const field of row.nested.fields || []) {
        await fillField(await oneField(page, `${prefix}${field.nameSuffix}`), { ...field, name: `${prefix}${field.nameSuffix}` }, collection.label);
      }
    }
    await saveVisibleForm(page);
  } else {
    await closeVisibleForm(page);
  }

  await openCollectionRow(page, collection, row);
  for (const field of row.fields || []) results.push(await readField(await oneField(page, field.name), field, collection.label));
  if (row.nested) {
    const prefix = await nestedPrefix(page, row.nested);
    for (const field of row.nested.fields || []) {
      results.push(await readField(await oneField(page, `${prefix}${field.nameSuffix}`), { ...field, name: `${prefix}${field.nameSuffix}` }, collection.label));
    }
  }
  await closeVisibleForm(page);
}

async function correctionNavigation(page) {
  await gotoSafe(page, projectUrl);
  const candidate = await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const wanted = /(karta\s+poprawy|rekomendacje|poprawa\s+wniosku|korekta\s+wniosku|korekta)/i;
    return Array.from(document.querySelectorAll('a, button, [role="button"]')).map((element) => ({
      text: norm(element.textContent).slice(0, 160),
      href: element instanceof HTMLAnchorElement ? element.href : '',
    })).filter((item) => wanted.test(item.text) && !/wyślij|złóż|podpisz/i.test(item.text))[0] || null;
  }); // allow-raw-playwright: discover the visible correction-card navigation control
  if (!candidate) throw new Error('correction-card navigation control not found');
  if (candidate.href) {
    if (!candidate.href.startsWith(projectUrl)) throw new Error(`unsafe correction-card link: ${candidate.href}`);
    await gotoSafe(page, candidate.href);
  } else {
    await clickExactSafe(page, 'button', candidate.text);
    await installSubmissionGuard(page);
  }
  const body = normalize(await page.locator('body').innerText());
  if (!body.includes(plan.correctionCard.headingNeedle)) throw new Error('criterion 2 heading not found after correction navigation');
}

async function exposeCriterionForm(page) {
  const state = await page.evaluate((headingNeedle) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const all = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, td, th, div, span, p'));
    const headings = all.filter((element) => norm(element.textContent) === headingNeedle).sort((a, b) => a.childElementCount - b.childElementCount);
    const heading = headings[0];
    if (!heading) return { found: false };
    const row = heading.closest('tr');
    const container = row || heading.closest('[role="region"], .MuiAccordion-root, form') || heading.parentElement;
    const hasControl = Boolean(container?.querySelector('textarea, input[type="text"]'));
    if (!hasControl) {
      const menu = container?.querySelector('button[aria-label="overflow-options"]');
      const edit = Array.from(container?.querySelectorAll('button, [role="button"]') || []).find((button) => norm(button.textContent) === 'Edytuj');
      const target = menu || edit || heading;
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { found: true, clicked: Boolean(target), usedMenu: Boolean(menu) };
    }
    return { found: true, clicked: false, usedMenu: false };
  }, plan.correctionCard.headingNeedle); // allow-raw-playwright: expose only the exact criterion 2 form or row menu
  if (!state.found) throw new Error('criterion 2 container not found');
  if (state.clicked) await humanIdlePause('long');
  if (state.usedMenu) {
    const edit = page.getByRole('menuitem', { name: 'Edytuj', exact: true }).filter({ visible: true });
    if (await edit.count() > 0) {
      await edit.first().click(); // allow-raw-playwright: edit only the previously selected criterion 2 row
      await humanIdlePause('long');
    }
  }
}

async function criterionControl(page) {
  const descriptor = await page.evaluate(({ headingNeedle, labels }) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const all = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, td, th, div, span, p'));
    const heading = all.filter((element) => norm(element.textContent) === headingNeedle).sort((a, b) => a.childElementCount - b.childElementCount)[0];
    if (!heading) return null;
    const nextHeadings = all.filter((element) => /^Kryterium\s+\d+\./i.test(norm(element.textContent)) && element !== heading && (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
    const next = nextHeadings.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1)[0] || null;
    const controls = Array.from(document.querySelectorAll('textarea, input[type="text"]')).filter((control) => {
      if (!(heading.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      if (next && !(control.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      return control.getClientRects().length > 0;
    });
    const ranked = controls.map((control, index) => {
      const label = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null;
      const nearby = norm(label?.textContent || control.closest('label, form, [role="region"], .MuiFormControl-root')?.textContent || '');
      const score = labels.some((needle) => nearby.includes(needle)) ? 2 : 0;
      return { index, score, name: control.getAttribute('name') || '', id: control.id || '' };
    }).sort((a, b) => b.score - a.score);
    return ranked[0] || null;
  }, { headingNeedle: plan.correctionCard.headingNeedle, labels: plan.correctionCard.answerLabelNeedles }); // allow-raw-playwright: locate the visible applicant-response control inside criterion 2
  if (!descriptor) throw new Error('criterion 2 response control not found');
  if (descriptor.id) return page.locator(`#${descriptor.id}`).first();
  if (descriptor.name) return page.locator(`[name="${descriptor.name}"]`).first();
  throw new Error('criterion 2 response control has no stable selector');
}

async function applyCorrectionCard(page) {
  await correctionNavigation(page);
  await exposeCriterionForm(page);
  let control = await criterionControl(page);
  const field = { name: 'criterion-2-answer', value: plan.correctionCard.value, maxLength: plan.correctionCard.maxLength };
  if (mode === 'apply') {
    await fillField(control, field, 'KPW');
    await saveVisibleForm(page);
  } else {
    await closeVisibleForm(page);
  }

  await correctionNavigation(page);
  await exposeCriterionForm(page);
  control = await criterionControl(page);
  results.push(await readField(control, field, 'KPW'));
  await closeVisibleForm(page);
}

function persistReport(status, error = null) {
  const payload = {
    schema: 'weles.ncbr.correction-report.v1',
    runId,
    mode,
    status,
    projectId: plan.project.id,
    applicationNumber: plan.project.applicationNumber,
    submissionClicked,
    results,
    error: error ? String(error.message || error) : null,
  };
  writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

let browser;
try {
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error('NO_PAGE');
  page.setDefaultTimeout(30_000);

  const identity = await projectIdentity(page);
  if (!identity.hasApplicationNumber) {
    console.error('[ncbr-correction] application number is not rendered on the project root; project UUID, title, and correction status matched');
  }
  for (const section of plan.sections) await applyScalarSection(page, section);
  for (const collection of plan.collections) {
    for (const row of collection.rows) await applyCollectionRow(page, collection, row);
  }
  await applyCorrectionCard(page);

  const blocked = await page.evaluate(() => window.__welesNcbrBlockedSubmissionClicks || []).catch(() => []); // allow-raw-playwright: read submission-guard evidence
  submissionClicked = blocked.length > 0;
  if (submissionClicked) throw new Error(`submission guard blocked ${blocked.length} click(s)`);
  const payload = persistReport('complete');
  console.log(JSON.stringify({ ...payload, results: payload.results.map(({ scope, name, length, sha256: hash, persisted, ...rest }) => ({ scope, name, length, sha256: hash, persisted, ...rest })), reportPath }, null, 2));
} catch (error) {
  const payload = persistReport('failed', error);
  console.error(JSON.stringify({ ...payload, reportPath }, null, 2));
  process.exitCode = 1;
}
