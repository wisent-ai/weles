// Scrape the SPRIND "Next Frontier AI" challenge submission page and dump
// every visible field, label, helper text, section heading, and select
// option as JSON. Page is fully public — no proxy, no auth.
//
// Run:
//   node weles/src/trajectories/sprind/next_frontier_ai.mjs
//
// Output (under recordings/sprind_next_frontier_ai/):
//   fields.json   — structured field list
//   page.html     — full outerHTML at end of run
//   page.png      — full-page screenshot
// stdout: one-line summary (N fields, M headings, K buttons)

import { WSession } from '../../../dist/session/wsession.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const URL = 'https://www.sprind.org/taten/challenges/submissions/next-frontier-ai';
const LABEL = 'sprind_next_frontier_ai';
const OUT_DIR = runRecordingsDir(LABEL);
mkdirSync(OUT_DIR, { recursive: true });

const s = await WSession.start({ label: LABEL, proxy: process.env.PROXY_URL || undefined });

try {
  await s.goto(URL);

  // Webflow / Tally / similar embedded forms hydrate after first paint;
  // poll for the first input/textarea/select to render before extracting,
  // then idle a beat so late-mounted sections settle.
  for (let i = 0; i < 30; i++) {
    const ready = await s.page.evaluate(() => !!document.querySelector('input, textarea, select'));
    if (ready) break;
    await s.wait(1);
  }
  await s.wait(2);

  const extract = await s.page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };

    const labelFor = (el) => {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return lab.innerText.trim();
      }
      const ancestorLabel = el.closest('label');
      if (ancestorLabel) {
        const clone = ancestorLabel.cloneNode(true);
        clone.querySelectorAll('input,textarea,select,button').forEach((n) => n.remove());
        const t = clone.innerText.trim();
        if (t) return t;
      }
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = [];
        for (const id of labelledBy.split(/\s+/)) {
          const node = document.getElementById(id);
          if (node) parts.push(node.innerText.trim());
        }
        const t = parts.filter(Boolean).join(' ');
        if (t) return t;
      }
      const container = el.closest('.field, .form-field, .w-form-field, [data-name], section, fieldset, div');
      if (container) {
        const heading = container.querySelector('label, .field-label, .form-label, h2, h3, h4, strong');
        if (heading && !heading.contains(el)) return heading.innerText.trim();
      }
      return el.placeholder || el.name || '';
    };

    const helperFor = (el) => {
      const container = el.closest('.field, .form-field, .w-form-field, [data-name], section, fieldset, div');
      if (!container) return '';
      const helpers = container.querySelectorAll('.helper, .help, .form-help, .field-help, .description, small, .text-sm');
      return Array.from(helpers).map((n) => n.innerText.trim()).filter(Boolean).join(' | ');
    };

    const fields = [];
    document.querySelectorAll('input, textarea, select').forEach((el) => {
      if (!visible(el) && el.type !== 'hidden') return;
      const base = {
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        label: labelFor(el),
        placeholder: el.placeholder || null,
        required: el.required || el.getAttribute('aria-required') === 'true',
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        max: el.max || null,
        min: el.min || null,
        pattern: el.pattern || null,
        helper: helperFor(el),
      };
      if (el.tagName === 'SELECT') {
        base.options = Array.from(el.options).map((o) => ({ value: o.value, text: o.text.trim() }));
      }
      // Textareas on this form have no HTML maxlength; the limit lives in
      // the label as a trailing "0/<N>". Verified empirically (counter
      // numerator tracks value.length, not word count) — see
      // probe_counter_unit.mjs. Surface it as maxChars so downstream
      // consumers don't have to re-parse the label string.
      const m = base.label.match(/(?:^|\s)0\s*\/\s*(\d{1,5})\s*$/);
      if (m) base.maxChars = parseInt(m[1], 10);
      fields.push(base);
    });

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
      .map((h) => ({ level: h.tagName.toLowerCase(), text: h.innerText.trim() }))
      .filter((h) => h.text);

    const buttons = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button]'))
      .filter((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      })
      .map((b) => ({ text: (b.innerText || b.value || '').trim(), type: b.type || null, name: b.name || null }))
      .filter((b) => b.text);

    return {
      url: location.href,
      title: document.title,
      headings,
      fields,
      buttons,
      formCount: document.querySelectorAll('form').length,
      bodyTextLength: (document.body.innerText || '').length,
    };
  });

  writeFileSync(join(OUT_DIR, 'fields.json'), JSON.stringify(extract, null, 2));
  const html = await s.page.content();
  writeFileSync(join(OUT_DIR, 'page.html'), html);
  await s.page.screenshot({ path: join(OUT_DIR, 'page.png'), fullPage: true });

  console.log(`PASS: ${extract.fields.length} fields, ${extract.headings.length} headings, ${extract.buttons.length} buttons, ${extract.formCount} <form>s — wrote ${OUT_DIR}`);
} finally {
  await s.close();
}
