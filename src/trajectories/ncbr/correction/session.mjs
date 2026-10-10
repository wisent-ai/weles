// One signed-in LSI2 browser connection that serves many correction commands.
//
// Chrome asks the operator to allow every new DevTools client of the profile
// he is signed in with. A run that connects once per command makes him answer
// that question once per command. This service connects once, opens its own
// tab in the signed-in profile (it never drives the operator's tabs), and then
// reads one command per line on stdin and answers one JSON line on stdout:
//
//   sections                 section labels and their projekt_step addresses
//   read <label>             every field of the section and its table rows
//   readrow <label> <n>      every field of row n (0-based) of the section table
//   apply <plan.json> [label]  apply a text-edit plan (below), or only its edits for
//                            one section; save, re-read, verify
//   quit                     close the service's own tab and disconnect
//
// A plan is {"edits": [...]}; an edit is {"section": "2.2", "from": "...",
// "to": "..."} and optionally "field" (an exact field name) and "row" (text the
// row's table line contains). `from` matches with any run of whitespace
// standing for any other, because the application preview the edits come from
// wraps lines where the field has spaces. Without "row", a section with a
// table is searched field by field and row by row. Every occurrence is
// replaced; an edit that matches nothing is reported, never guessed. A choice
// field is an edit {"section", "field", "control": "select", "labelIncludes"}.
// Every changed field is saved on its own (LSI2 drops a second unsaved field)
// and read back after a reload. Nothing here clicks a submission control.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { normalize, sha256 } from './plan.mjs';
import {
  fillPrepared,
  prepareFields,
  snapshotFields,
  verifyPrepared,
} from './fields.mjs';
import { clickSafe, closeDrawer, gotoSafe, save } from './ui.mjs';

const settings = await import('#ncbr-settings');
const projectUrl = settings.projectUrl();
// Chrome holds the connection until the operator answers its approval question; wait for that answer.
const browser = await chromium.connectOverCDP(settings.cdpEndpoint(), {
  timeout: 0,
});
const context = browser.contexts()[0];
if (!context) throw new Error('The signed-in browser exposes no context');
const page = await context.newPage();
let sectionUrls = null;

const answer = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function sections() {
  await gotoSafe(page, projectUrl, projectUrl);
  const links = await page
    .locator('a[href*="/projekt_step/"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent.replace(/\s+/g, ' ').trim(),
        url: node.href,
      })),
    );
  const found = new Map();
  for (const link of links) {
    const label = link.text.match(/^(\d+(?:\.\d+)?)\./)?.[1];
    if (label && !found.has(label)) found.set(label, link.url);
  }
  if (!found.size) throw new Error(`${projectUrl} shows no projekt_step links`);
  sectionUrls = found;
  return Object.fromEntries(found);
}

async function sectionUrl(label) {
  if (!sectionUrls) await sections();
  const url = sectionUrls.get(label);
  if (!url)
    throw new Error(
      `No section ${label}; the project shows ${[...sectionUrls.keys()].join(', ')}`,
    );
  return url;
}

const tableRows = () =>
  page
    .locator('table tbody tr')
    .filter({ has: page.locator('button[aria-label="overflow-options"]') });

async function rowTexts() {
  return tableRows().evaluateAll((nodes) =>
    nodes.map((node) => node.innerText.replace(/\s+/g, ' ').trim()),
  ); // allow-raw-playwright: read-only row texts
}

async function openSection(label) {
  await gotoSafe(page, await sectionUrl(label), projectUrl);
}

async function openRowAt(label, index) {
  await openSection(label);
  const rows = tableRows();
  await rows.first().waitFor({ state: 'visible' });
  const count = await rows.count();
  if (index >= count)
    throw new Error(
      `${label}: row ${index} does not exist; the table has ${count}`,
    );
  await clickSafe(
    rows.nth(index).locator('button[aria-label="overflow-options"]'),
    'row menu',
  );
  await clickSafe(
    page
      .getByRole('menuitem', { name: 'Edytuj', exact: true })
      .filter({ visible: true }),
    'Edytuj',
  );
  await page
    .locator('#collection-obj-form-save-btn')
    .filter({ visible: true })
    .waitFor({ state: 'visible' });
}

const textFields = (snapshot) =>
  snapshot.filter(
    (field) =>
      (field.tag === 'TEXTAREA' ||
        (field.tag === 'INPUT' && field.type === 'text')) &&
      !field.readOnly &&
      !field.disabled,
  );

// `from` with every whitespace run standing for any whitespace run.
function pattern(from) {
  const tokens = normalize(from)
    .split(' ')
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(tokens.join('\\s+'), 'g');
}

// The new value of every field one or more pending edits match, keyed by field name.
function planValues(snapshot, edits) {
  const values = new Map();
  for (const field of textFields(snapshot)) {
    let value = field.value;
    for (const edit of edits) {
      if (edit.control || (edit.field && edit.field !== field.name)) continue;
      const next = value.replace(pattern(edit.from), () => edit.to);
      if (next !== value) {
        edit.matches.push(field.name);
        value = next;
      }
    }
    if (value !== field.value)
      values.set(
        field.name,
        value
          .replace(/ {2,}/g, ' ')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim(),
      );
  }
  return values;
}

// Saves each changed field on its own and returns the verified fields.
async function writeFields(values, reopen, collection, scope) {
  const written = [];
  for (const [name, value] of values) {
    await reopen();
    const [field] = await prepareFields(page, [{ name, value }], {}, scope);
    if (field.before === field.expected) {
      written.push(field);
      continue;
    }
    await fillPrepared(page, [field]);
    await save(page, collection, [field]);
    written.push(field);
  }
  if (written.length) {
    await reopen();
    await verifyPrepared(page, written);
    if (collection) await closeDrawer(page);
  }
  return written.map(({ name, before, expected, persisted }) => ({
    name,
    beforeChars: before.length,
    afterChars: expected.length,
    persisted,
    sha256: sha256(expected),
  }));
}

async function writeChoice(edit) {
  const reopen = () => openSection(edit.section);
  await reopen();
  const [field] = await prepareFields(
    page,
    [
      {
        name: edit.field,
        control: 'select',
        labelIncludes: edit.labelIncludes,
      },
    ],
    {},
    edit.section,
  );
  if (field.expected === null || field.before !== field.expected) {
    await fillPrepared(page, [field]);
    await save(page, false, [field]);
    await reopen();
    await verifyPrepared(page, [field]);
  }
  edit.matches.push(field.name);
  return {
    name: field.name,
    option: field.optionLabel,
    persisted: field.persisted ?? true,
  };
}

async function apply(planPath, only) {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (!Array.isArray(plan.edits) || !plan.edits.length)
    throw new Error(`${planPath} holds no edits`);
  const edits = plan.edits
    .filter((edit) => !only || edit.section === only)
    .map((edit) => ({ ...edit, matches: [] }));
  if (!edits.length)
    throw new Error(`${planPath} holds no edits for section ${only}`);
  const results = [];
  for (const label of [...new Set(edits.map((edit) => edit.section))]) {
    const scoped = edits.filter((edit) => edit.section === label);
    for (const edit of scoped.filter((item) => item.control))
      results.push({ section: label, choice: await writeChoice(edit) });
    // The same current text bound for two different targets (a number in two columns) cannot be placed by text; refuse both.
    const targets = new Map();
    for (const edit of scoped)
      if (!edit.control && !edit.field)
        targets.set(
          normalize(edit.from),
          new Set([...(targets.get(normalize(edit.from)) || []), edit.to]),
        );
    const conflicting = scoped.filter(
      (edit) =>
        !edit.control &&
        !edit.field &&
        targets.get(normalize(edit.from)).size > 1,
    );
    for (const edit of conflicting) edit.conflict = true;
    const texts = scoped.filter((edit) => !edit.control && !edit.conflict);
    if (!texts.length) continue;
    await openSection(label);
    const own = planValues(await snapshotFields(page), texts);
    if (own.size)
      results.push({
        section: label,
        fields: await writeFields(own, () => openSection(label), false, label),
      });
    const rows = await rowTexts();
    for (const [index, text] of rows.entries()) {
      const rowEdits = texts.filter(
        (edit) => !edit.row || normalize(text).includes(normalize(edit.row)),
      );
      if (!rowEdits.length) continue;
      await openRowAt(label, index);
      const values = planValues(await snapshotFields(page), rowEdits);
      await closeDrawer(page);
      if (values.size)
        results.push({
          section: label,
          row: text.slice(0, 120),
          fields: await writeFields(
            values,
            () => openRowAt(label, index),
            true,
            `${label}#${index}`,
          ),
        });
    }
  }
  const unmatched = edits
    .filter((edit) => !edit.matches.length)
    .map(({ section, from, field, conflict }) => ({
      section,
      field,
      from,
      conflict: Boolean(conflict),
    }));
  return { results, unmatched };
}

async function read(label) {
  await openSection(label);
  return {
    section: label,
    url: page.url(),
    fields: await snapshotFields(page),
    rows: await rowTexts(),
  };
}

async function readRow(label, index) {
  await openRowAt(label, index);
  const fields = await snapshotFields(page);
  await closeDrawer(page);
  return { section: label, row: index, fields };
}

const commands = {
  sections: () => sections(),
  read: (label) => read(label),
  readrow: (label, index) => readRow(label, Number(index)),
  apply: (path, label) => apply(path, label),
};

answer({ status: 'ready', projectUrl });
for await (const line of createInterface({ input: process.stdin })) {
  const [name, ...args] = line.trim().split(/\s+/);
  if (!name) continue;
  if (name === 'quit') break;
  const command = commands[name];
  if (!command) {
    answer({
      status: 'refused',
      error: `unknown command ${name}; use sections, read, readrow, apply or quit`,
    });
    continue;
  }
  try {
    answer({ status: 'ok', command: name, result: await command(...args) });
  } catch (error) {
    answer({
      status: 'failed',
      command: name,
      url: page.url(),
      error: String(error.message || error),
    });
  }
}
await page.close();
process.exit(0);
