// Read-only keeper audit for the replacement NCBR STEP B draft.
// Uses existing keeper session only. Never saves, uploads, deletes, withdraws, or submits.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR, PROJECT_ID, PROJECT_URL, SECTIONS, SESSION } from './audit_keeper_readonly/settings.mjs';
import { nav, read, send } from './audit_keeper_readonly/keeper.mjs';
import {
  dumpCurrent, dumpSection, inspectDocuments, loginIfNeeded, navigateByVisibleLabel, validateOnly,
} from './audit_keeper_readonly/sections.mjs';

const out = {
  projectId: PROJECT_ID,
  startedAt: new Date().toISOString(),
  keeperSession: SESSION,
  sections: [],
  documents: null,
  validation: null,
};

try {
  out.current = await send({ action: 'url' }, 30000);
  out.login = await loginIfNeeded();
  if (out.login.status === 'needs_credentials' || out.login.status === 'still_login_page') {
    throw new Error(`login failed: ${out.login.status}`);
  }
  if (process.env.NAV_LABEL) {
    const state = await navigateByVisibleLabel(process.env.NAV_LABEL);
    if (process.env.EDIT_ROW_TEXT) {
      await send({ action: 'click', selector: `tr:has-text(${JSON.stringify(process.env.EDIT_ROW_TEXT)}) button[aria-label="overflow-options"]` }, 120000);
      await send({ action: 'humanidle', kind: 'deliberate' }, 60000).catch(() => null);
      await send({ action: 'click', selector: `text="Edytuj"` }, 120000);
      await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
      const editState = await dumpCurrent(`${process.env.NAV_LABEL}__edit`);
      await send({ action: 'click', selector: `button:has-text("Anuluj")` }, 120000).catch(() => null);
      await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
      const fp = join(OUT_DIR, `edit_${String(process.env.EDIT_ROW_TEXT).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 80)}.json`);
      writeFileSync(fp, JSON.stringify({ ...out, nav: state, edit: editState }, null, 2));
      console.log(JSON.stringify({
        ok: true,
        out: fp,
        url: editState.url,
        fields: editState.fields.map((f) => ({ name: f.name, type: f.type, len: f.len, value: f.value, suffix: f.suffix })).slice(0, 100),
        buttons: editState.buttons.filter((b) => /Zapisz|Anuluj/i.test(b.text)),
        shot: editState.screenshot.path,
      }, null, 2));
      process.exit(0);
    }
    const fp = join(OUT_DIR, `nav_${String(process.env.NAV_LABEL).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 80)}.json`);
    writeFileSync(fp, JSON.stringify({ ...out, nav: state }, null, 2));
    console.log(JSON.stringify({
      ok: true,
      out: fp,
      url: state.url,
      tables: state.tables.map((t) => ({ i: t.i, rows: t.rows, text: t.text.join(' || ').slice(0, 1800) })),
      fields: state.fields.map((f) => ({ name: f.name, len: f.len, value: f.value.slice(0, 140), suffix: f.suffix.slice(-140) })).slice(0, 80),
      buttons: state.buttons.filter((b) => /Złóż|Sprawdź|Zapisz/i.test(b.text)),
      shot: state.screenshot.path,
    }, null, 2));
    process.exit(0);
  }
  if (process.env.META === '1') {
    await nav(PROJECT_URL);
    const meta = await read(`(async () => {
      async function fetchText(path) {
        const res = await fetch('https://lsi2.ncbr.gov.pl' + path, { credentials: 'include', headers: { Accept: 'application/json' } });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return { status: res.status, text: text.slice(0, 2000), data };
      }
      const links = Array.from(document.querySelectorAll('a[href], [href]')).map((a) => ({
        text: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
        href: a.href || a.getAttribute('href') || '',
      })).filter((x) => x.href.includes('/projekt_step/'));
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map((b) => (b.textContent || '').trim().replace(/\\s+/g, ' ')).filter(Boolean);
      return {
        url: location.href,
        links,
        buttons,
        project: await fetchText('/api/beneficiary/project/${PROJECT_ID}'),
        projectsPlural: await fetchText('/api/beneficiary/projects/${PROJECT_ID}'),
        resources: performance.getEntriesByType('resource').map((e) => e.name).filter((name) => /project|section|version|APPLICATION_DATA/i.test(name)).slice(-120),
      };
    })()`);
    const fp = join(OUT_DIR, 'meta.json');
    writeFileSync(fp, JSON.stringify({ ...out, meta }, null, 2));
    console.log(JSON.stringify({ ok: true, out: fp, linkCount: meta.links.length, buttons: meta.buttons.slice(0, 80), resourceCount: meta.resources.length }, null, 2));
    process.exit(0);
  }
  for (const [label, id] of SECTIONS) out.sections.push(await dumpSection(label, id));
  out.documents = await inspectDocuments();
  out.validation = await validateOnly();
  out.finishedAt = new Date().toISOString();
  const fp = join(OUT_DIR, 'audit.json');
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    ok: true,
    out: fp,
    sections: out.sections.map((s) => ({ label: s.label, tables: s.tables.map((t) => t.rows), markdownHits: s.markdownLikeFields.length, suspiciousEndings: s.suspiciousEndings.length, shot: s.screenshot.path })),
    documents: { rows: out.documents.tables.map((t) => t.rows), fileInputs: out.documents.fileInputs, shot: out.documents.screenshot.path },
    validation: { dialogs: out.validation.dialogs, errorLikeLines: out.validation.errorLikeLines, buttons: out.validation.buttons.filter((b) => /Złóż|Sprawdź|Potwierdzam/i.test(b.text)), shot: out.validation.screenshot.path },
  }, null, 2));
} catch (e) {
  out.error = String(e?.message || e);
  const fp = join(OUT_DIR, 'audit_failed.json');
  writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: false, out: fp, error: out.error }, null, 2));
  process.exitCode = 1;
}
