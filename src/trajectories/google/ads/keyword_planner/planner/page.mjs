// Driving the Keyword Planner page: the account selector, the keyword input, and the harvest.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';
import { humanFill } from '../../../../../../dist/human/keyboard.js';
import { NAV_TIMEOUT_MS, cid, dashedCustomerId, keywords, norm } from './settings.mjs';
import { preferredGoogleAdsEmail } from './sign_in.mjs';
import { buildGoogleAdsPath, campaignsUrl, summarizeKeywordPlannerResponses } from './capture.mjs';
import { collectDom, parseKeywordRows } from './dom.mjs';

export async function clickByText(page, pattern, label) {
  const control = page.getByRole('button', { name: pattern }).filter({ visible: true }).first()
    .or(page.getByRole('link', { name: pattern }).filter({ visible: true }).first())
    .or(page.getByText(pattern).filter({ visible: true }).first());
  if (await control.isVisible().catch(() => false)) {
    console.log(`[google-ads-keyword-planner] clicking ${label}`);
    await humanClickLocator(page, control);
    await humanIdlePause('deliberate');
    return true;
  }
  return false;
}

export async function continueFromGoogleAdsAccountSelector(page) {
  if (!/ads\.google\.com\/nav\/selectaccount/i.test(page.url?.() || '')) return false;
  const dashed = dashedCustomerId(cid);
  const candidates = [
    page.getByText(new RegExp(dashed.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))).filter({ visible: true }).first(),
    page.getByText(/Wisent-AI, Inc/i).filter({ visible: true }).first(),
    page.getByText(/Google Ads account/i).filter({ visible: true }).first(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      console.log(`[google-ads-keyword-planner] selecting Google Ads account ${dashed}`);
      await humanClickLocator(page, candidate);
      await humanIdlePause('deliberate');
      return true;
    }
  }
  return false;
}

export async function fillKeywordInput(page) {
  const text = keywords.join('\n');
  const result = await page.evaluate(({ text }) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width < 4 || rect.height < 4) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') !== 0;
    };
    const candidates = [];
    const seen = new Set();
    const visit = (root) => {
      for (const el of root.querySelectorAll?.('textarea,input,[contenteditable="true"],[role="textbox"]') || []) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.shadowRoot) visit(el.shadowRoot);
        if (!visible(el)) continue;
        const descriptor = norm([
          el.getAttribute?.('aria-label') || '',
          el.getAttribute?.('placeholder') || '',
          el.getAttribute?.('title') || '',
          el.closest?.('label')?.innerText || '',
          el.parentElement?.innerText || '',
        ].join(' '));
        let score = 0;
        if (/keyword|products?|services?|search terms?|phrases?/i.test(descriptor)) score += 20;
        if (/website|domain|url|landing page/i.test(descriptor)) score -= 30;
        if ((el.tagName || '').toLowerCase() === 'textarea') score += 8;
        if (el.getAttribute?.('role') === 'textbox') score += 5;
        candidates.push({ el, descriptor, score });
      }
    };
    visit(document);
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.find((candidate) => candidate.score > 0) || candidates[0];
    if (!selected) return { ok: false, reason: 'no_keyword_input' };
    const el = selected.el;
    el.focus();
    if ('value' in el) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return {
      ok: true,
      descriptor: selected.descriptor.slice(0, 300),
      tag: (el.tagName || '').toLowerCase(),
      role: el.getAttribute?.('role') || '',
    };
  }, { text });
  if (result?.ok) {
    console.log(`[google-ads-keyword-planner] filled keyword input ${JSON.stringify(result)}`);
    await humanIdlePause('deliberate');
    return result;
  }

  const fallback = page.locator('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"]')
    .filter({ visible: true })
    .first();
  if (await fallback.isVisible().catch(() => false)) {
    await humanFill(page, fallback, text);
    await humanIdlePause('deliberate');
    return { ok: true, descriptor: 'playwright_fallback' };
  }
  return result || { ok: false, reason: 'no_keyword_input' };
}

export async function openKeywordPlanner(s) {
  const candidates = [
    '/aw/keywordplanner/home',
    '/aw/keywordplanner/ideas/new',
    '/aw/keywordplanner/ideas',
    '/aw/keywordplanner',
  ];
  const attempts = [];
  for (const path of candidates) {
    const url = buildGoogleAdsPath(s.page.url?.() || campaignsUrl('cid', cid), path);
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((error) => {
      console.log(`[google-ads-keyword-planner] WARN: planner navigation failed ${path} ${String(error?.message || error).slice(0, 240)}`);
    });
    await s.wait(8);
    if (await continueFromGoogleAdsAccountSelector(s.page)) {
      await s.wait(8);
    }
    const dom = await collectDom(s.page);
    const matched = /keyword planner|discover new keywords|get search volume|forecasts?|keyword ideas|avg\.? monthly searches/i.test(dom.text);
    attempts.push({ path, url: dom.url || url, matched, textPreview: norm(dom.text).slice(0, 800), controls: dom.controls.slice(0, 20) });
    if (matched) return { ok: true, path, attempts };
  }
  const clickedTools = await clickByText(s.page, /Tools|Tools and settings|Planning|Keyword Planner/i, 'tools/planning navigation');
  if (clickedTools) {
    await clickByText(s.page, /Keyword Planner/i, 'Keyword Planner');
    await s.wait(8);
    const dom = await collectDom(s.page);
    const matched = /keyword planner|discover new keywords|get search volume|forecasts?|keyword ideas|avg\.? monthly searches/i.test(dom.text);
    attempts.push({ path: 'menu_keyword_planner', url: dom.url, matched, textPreview: norm(dom.text).slice(0, 800), controls: dom.controls.slice(0, 20) });
    if (matched) return { ok: true, path: 'menu_keyword_planner', attempts };
  }
  return { ok: false, attempts };
}

export async function collectKeywordPlanner(s, captured) {
  const before = await collectDom(s.page);
  await clickByText(s.page, /Discover new keywords|Get search volume and forecasts|Get search volume|Start with keywords/i, 'keyword planner mode');
  await s.wait(3);
  const fill = await fillKeywordInput(s.page);
  const actionClicks = [];
  for (const action of [
    { label: 'Get results', pattern: /Get results/i },
    { label: 'See results', pattern: /See results/i },
    { label: 'View results', pattern: /View results/i },
    { label: 'Start', pattern: /Start|Get started/i },
    { label: 'Search', pattern: /^Search$/i },
  ]) {
    const clicked = await clickByText(s.page, action.pattern, action.label);
    actionClicks.push({ label: action.label, clicked });
    if (clicked) {
      await s.wait(12);
      break;
    }
  }
  await s.wait(8);
  const after = await collectDom(s.page);
  const rows = [...before.rows, ...after.rows];
  const parsedRows = parseKeywordRows(rows);
  return {
    customer: cid,
    customerDashed: dashedCustomerId(cid),
    preferredEmail: preferredGoogleAdsEmail(),
    keywords,
    url: s.page.url?.() || '',
    capturedAt: new Date().toISOString(),
    fill,
    actionClicks,
    rows: after.rows,
    controls: after.controls,
    parsedRows,
    visibleTextPreview: norm(after.text).slice(0, 3000),
    rpc: summarizeKeywordPlannerResponses(captured.responses),
    capturedRequestCount: captured.requests.length,
    capturedResponseCount: captured.responses.length,
    source: 'google_ads_keyword_planner_ui',
  };
}
