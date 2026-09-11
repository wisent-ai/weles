// Probing the history state: revealing the phrase in the editor, clicking visible text,
// and recording one probe.
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { dump, norm } from './page.mjs';
import { summarizeVisible } from './summarize.mjs';

export async function revealQueryInEditor(page, queryText) {
  const wanted = norm(queryText);
  if (!wanted) return { attempted: false, reason: 'empty-query' };

  const before = await summarizeVisible(page, wanted);
  if (before.targetIndex >= 0) {
    return {
      attempted: false,
      reason: 'already-found',
      targetMatchKind: before.targetMatchKind,
      targetScore: before.targetScore,
    };
  }

  const attempts = [];
  for (const shortcut of ['Meta+f', 'Control+f']) {
    try {
      await page.keyboard.press(shortcut);
      await page.waitForTimeout(300);
      await humanType(page, wanted);
      await page.waitForTimeout(700);
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(700);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1000);
      const after = await summarizeVisible(page, wanted);
      attempts.push({
        shortcut,
        targetMatchKind: after.targetMatchKind,
        targetScore: after.targetScore,
        targetIndex: after.targetIndex,
      });
      if (after.targetIndex >= 0) return { attempted: true, method: shortcut, attempts };
    } catch (err) {
      attempts.push({ shortcut, error: err?.message || String(err) });
    }
  }

  try {
    const found = await page.evaluate((text) => {
      if (typeof window.find !== 'function') return false;
      return window.find(text, false, false, true, false, true, false);
    }, wanted);
    await page.waitForTimeout(1000);
    const after = await summarizeVisible(page, wanted);
    attempts.push({
      method: 'window.find',
      found,
      targetMatchKind: after.targetMatchKind,
      targetScore: after.targetScore,
      targetIndex: after.targetIndex,
    });
    if (after.targetIndex >= 0) return { attempted: true, method: 'window.find', attempts };
  } catch (err) {
    attempts.push({ method: 'window.find', error: err?.message || String(err) });
  }

  return { attempted: true, method: null, attempts };
}

export async function clickVisibleText(page, text, tag, exact = false) {
  const loc = exact
    ? page.getByText(text, { exact: true }).filter({ visible: true }).first()
    : page.getByText(text).filter({ visible: true }).first();
  if (await loc.count() > 0) {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(page, loc);
    await page.waitForTimeout(1500);
    return { tag, text, clicked: true, method: 'locator' };
  }

  const fallback = page.locator('button,a,[role="button"],[role="treeitem"],li')
    .filter({ hasText: text, visible: true }).first();
  if (await fallback.count() === 0) return { tag, text, clicked: false, method: null };
  const detail = await fallback.evaluate((el) => ({
    text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    tagName: el.tagName,
    role: el.getAttribute('role') || '',
  }));
  await humanClickLocator(page, fallback);
  await page.waitForTimeout(1500);
  return { tag, text, clicked: true, method: 'locator-fallback', clicked: detail };
}

export async function probeHistoryState(s, tag, queryText, reveal = false) {
  const revealResult = reveal ? await revealQueryInEditor(s.page, queryText) : null;
  const d = await dump(s, tag);
  const summary = await summarizeVisible(s.page, queryText);
  return {
    tag,
    path: d.text,
    url: s.page.url(),
    targetIndex: summary.targetIndex,
    targetMatchKind: summary.targetMatchKind,
    targetScore: summary.targetScore,
    targetContext: summary.targetContext,
    documentText: summary.documentText,
    documentTextSource: summary.documentTextSource,
    documentTextLength: summary.documentTextLength,
    editorTextSources: summary.editorTextSources,
    revealResult,
    bodyHead: summary.bodyHead,
    visibleItems: summary.visibleItems,
  };
}
