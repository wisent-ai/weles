// Apple Ads report harvester.
//
// Uses a Weles browser session and reads DOM/network only. Authentication is
// delegated exclusively to an explicitly authorized apple_login run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { generatePersona } from '../../../../dist/browser/persona.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'apple_ads');
const DIAG_DIR = process.env.APPLE_ADS_DIAG_DIR || '.work/apple-ads-report-harvest';
const APP_ID = process.env.APPLE_ADS_APP_ID || process.env.APPLE_ADS_UI_APP_ID || '19768040';
const SESSION_LABEL = process.env.APPLE_ADS_SESSION_LABEL || 'apple_ads_report_harvest';
const REPORT_URL = process.env.APPLE_ADS_REPORT_URL || `https://app-ads.apple.com/cm/app/${APP_ID}/report`;
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 90000);
const WAIT_AFTER_NAV_MS = Number(process.env.APPLE_ADS_REPORT_WAIT_MS || 10000);
const CLOSE_AFTER_HARVEST = process.env.APPLE_ADS_CLOSE_AFTER_HARVEST === '1';
const KEEP_OPEN_AFTER_HARVEST_MS = Number(process.env.APPLE_ADS_KEEP_OPEN_AFTER_HARVEST_MS || 0);
const DATE_PRESETS = (process.env.APPLE_ADS_DATE_PRESETS || 'Last 30 days,Last 12 weeks,Last 3 Calendar months')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const EXACT_RANGES = (process.env.APPLE_ADS_EXACT_RANGES || [
  'Initial=2025-12-02..2025-12-13',
  'Initial_copy=2026-01-19..2026-01-31',
  'all_active_campaign_dates=2025-12-02..2026-01-31',
].join(','))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    const [label, range] = value.split('=');
    const [startTime, endTime] = String(range || '').split('..');
    return { label: label || `${startTime}_${endTime}`, startTime, endTime };
  })
  .filter((range) => /^\d{4}-\d{2}-\d{2}$/.test(range.startTime || '') && /^\d{4}-\d{2}-\d{2}$/.test(range.endTime || ''));

process.env.WELES_CAPTURE_RESPONSE_BODIES ??= '1';
process.env.WELES_DISABLE_RECORDING ??= '1';
process.env.WELES_NO_INSTRUMENT ??= '1';
process.env.WELES_VIEWPORT ??= '1440x1000';

mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(DIAG_DIR, { recursive: true });

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function norm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isAppleLoginUrl(url) {
  return /idmsa\.apple\.com|appleid\.apple\.com|signin|login/i.test(url || '');
}

async function requireAuthenticatedSession(s) {
  const url = s.page.url?.() || '';
  if (url === 'about:blank') return false;

  const loginUrl = isAppleLoginUrl(url);
  const authIframe = await s.page.locator('iframe[src*="idmsa.apple.com"], iframe[src*="appleid.apple.com"]').count() > 0;
  let authPrompt = false;
  for (const frame of s.page.frames()) {
    authPrompt ||= await frame.locator([
      '#account_name_text_field',
      '#password_text_field',
      'input[type="password"]',
      'input[aria-label*="digit"]',
      'input[aria-label*="Digit"]',
      'input[type="tel"][maxlength="1"]',
    ].join(', ')).first().isVisible().catch(() => false);
    authPrompt ||= await frame.getByText(/Two-Factor Authentication|verification code sent to your Apple devices/i).first().isVisible().catch(() => false);
    if (authPrompt) break;
  }
  if (loginUrl || authIframe || authPrompt) {
    console.log('FAIL_CLOSED: Apple login/password/2FA is required; this harvester will not authenticate. An explicitly authorized apple_login is the only permitted login path.');
    return false;
  }
  return true;
}

async function gotoAndWait(page, url) {
  console.log(`[apple-ads-report-harvest] goto start ${url}`);
  const navigated = await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS })
    .then(() => true)
    .catch((error) => {
      console.log(`[apple-ads-report-harvest] goto error ${String(error?.message || error).slice(0, 300)}`);
      return false;
    });
  await page.waitForLoadState('domcontentloaded', { timeout: WAIT_AFTER_NAV_MS }).catch(() => {});
  await page.waitForTimeout(WAIT_AFTER_NAV_MS).catch(() => {});
  console.log(`[apple-ads-report-harvest] goto done navigated=${navigated} url=${page.url?.() || ''}`);
  return Boolean(navigated && (page.url?.() || '') !== 'about:blank');
}

async function ensureReportPage(page) {
  const url = page.url?.() || '';
  if (/\/report/i.test(url)) return true;
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/Manage Your Campaigns|Reporting is not in real time|Create Campaign|Campaign end date reached/i.test(text)) return true;
  return false;
}

function installNetworkCapture(page) {
  const requests = [];
  const responses = [];
  page.on('request', (request) => {
    try {
      const url = request.url();
      if (!/app-ads\.apple\.com\/reporting\/graphql|app-ads\.apple\.com\/cm\/api/i.test(url)) return;
      requests.push({
        ts: Date.now(),
        method: request.method(),
        url,
        postData: String(request.postData() || '').slice(0, 100000),
      });
      if (requests.length > 200) requests.shift();
    } catch {}
  });
  page.on('response', (response) => {
    void (async () => {
      try {
        const url = response.url();
        if (!/app-ads\.apple\.com\/reporting\/graphql|app-ads\.apple\.com\/cm\/api/i.test(url)) return;
        const headers = response.headers();
        const contentType = String(headers['content-type'] || '');
        let body = '';
        if (/json|text|javascript|html|xml/i.test(contentType)) {
          body = (await response.text().catch(() => '')).slice(0, 1000000);
        }
        responses.push({
          ts: Date.now(),
          method: response.request()?.method?.() || 'GET',
          url,
          status: response.status(),
          contentType,
          body,
        });
        if (responses.length > 200) responses.shift();
      } catch {}
    })();
  });
  return { requests, responses };
}

async function collectPageState(page) {
  return await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const short = (value, max = 600) => norm(value).slice(0, max);
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style && style.visibility !== 'hidden' && style.display !== 'none'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const cssPath = (el) => {
      const parts = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
        let part = node.localName || node.tagName.toLowerCase();
        if (node.id) {
          part += `#${node.id}`;
          parts.unshift(part);
          break;
        }
        const parent = node.parentElement || node.getRootNode()?.host || null;
        if (parent?.children) {
          const same = Array.from(parent.children).filter((child) => child.localName === node.localName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    };
    const roots = [];
    const addRoot = (root, label) => {
      roots.push({ root, label });
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.shadowRoot) addRoot(el.shadowRoot, `${label} >> ${el.localName}`);
      }
    };
    addRoot(document, 'document');

    const all = [];
    for (const { root, label } of roots) {
      for (const el of Array.from(root.querySelectorAll('*'))) all.push({ el, root: label });
    }

    const controls = all
      .filter(({ el }) => /^(a|button|input|select|textarea|option)$/i.test(el.tagName)
        || el.getAttribute('role')
        || el.onclick
        || el.tabIndex >= 0
        || /button|select|dropdown|calendar|date|menu|filter|download|export/i.test(el.className || ''))
      .map(({ el, root }, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index,
          root,
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          type: el.getAttribute('type') || '',
          id: el.id || '',
          name: el.getAttribute('name') || '',
          className: String(el.className || '').slice(0, 160),
          text: short(el.innerText || el.textContent || '', 240),
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          placeholder: el.getAttribute('placeholder') || '',
          value: 'value' in el ? short(el.value, 240) : '',
          href: el.href || '',
          checked: Boolean(el.checked),
          selected: Boolean(el.selected),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          expanded: el.getAttribute('aria-expanded') || '',
          visible: visible(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          path: cssPath(el),
        };
      })
      .filter((item) => item.visible || item.text || item.ariaLabel || item.value || item.href)
      .slice(0, 1000);

    const rows = all
      .filter(({ el }) => /^(tr|li|section|article)$/i.test(el.tagName) || el.getAttribute('role') === 'row')
      .map(({ el, root }) => ({
        root,
        tag: el.tagName,
        role: el.getAttribute('role') || '',
        text: short(el.innerText || el.textContent || '', 900),
        visible: visible(el),
        path: cssPath(el),
      }))
      .filter((row) => row.visible && row.text)
      .slice(0, 500);

    const storage = {};
    for (const storeName of ['localStorage', 'sessionStorage']) {
      try {
        const store = window[storeName];
        storage[storeName] = Array.from({ length: store.length }, (_, i) => {
          const key = store.key(i);
          const value = key ? store.getItem(key) : '';
          return {
            key,
            valueLength: value?.length || 0,
            valuePreview: /date|report|campaign|org|account|app|time|filter/i.test(key || '') ? short(value, 500) : undefined,
          };
        });
      } catch {
        storage[storeName] = [];
      }
    }

    const resources = performance.getEntriesByType('resource')
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        transferSize: Math.round(entry.transferSize || 0),
        duration: Math.round(entry.duration || 0),
      }))
      .filter((entry) => /app-ads\.apple\.com|searchads|report|campaign|budget|spend|analytics|api/i.test(entry.name))
      .slice(-300);

    return {
      url: location.href,
      title: document.title,
      text: short(document.body?.innerText || document.body?.textContent || '', 10000),
      controls,
      rows,
      storage,
      resources,
    };
  });
}

async function clickDatePreset(page, label) {
  return await page.evaluate(async (targetLabel) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clickElement = (el) => {
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    };
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return style && style.visibility !== 'hidden' && style.display !== 'none'
        && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    const allDeep = (root = document) => {
      const out = [];
      for (const el of Array.from(root.querySelectorAll('*'))) {
        out.push(el);
        if (el.shadowRoot) out.push(...allDeep(el.shadowRoot));
      }
      return out;
    };

    const picker = document.querySelector('apui-wc-date-range-picker');
    const opener = picker?.querySelector('.date-range-picker__main-content, .form-input--date-range-picker, .date-range-picker')
      || document.querySelector('.table-toolbar__date, .date-range-picker');
    if (!clickElement(opener)) return { ok: false, stage: 'open', reason: 'date picker opener not found' };
    await sleep(500);

    const candidates = allDeep()
      .filter((el) => norm(el.innerText || el.textContent) === targetLabel)
      .sort((a, b) => Number(visible(b)) - Number(visible(a)) || a.tagName.length - b.tagName.length);
    const item = candidates.find((el) => /^(LI|BUTTON|DIV|SPAN|A)$/i.test(el.tagName)) || candidates[0];
    if (!item) return { ok: false, stage: 'select', reason: `preset not found: ${targetLabel}` };
    const clickable = item.closest('li, button, [role="button"], a') || item;
    const clicked = clickElement(clickable);
    await sleep(1500);
    return {
      ok: clicked,
      stage: 'select',
      label: targetLabel,
      tag: clickable.tagName,
      text: norm(clickable.innerText || clickable.textContent),
      className: String(clickable.className || ''),
      visible: visible(clickable),
      url: location.href,
    };
  }, label).catch((error) => ({ ok: false, stage: 'exception', reason: error.message }));
}

function responseIsRelevant(response) {
  return /app-ads\.apple\.com|searchads|report|campaign|budget|spend|analytics|api/i.test(response.url || '');
}

function sanitizeResponses(responses) {
  return responses
    .filter(responseIsRelevant)
    .map((response) => {
      const contentType = String(response.headers?.['content-type'] || '');
      const body = String(response.body || '');
      return {
        ts: response.ts,
        method: response.method,
        url: response.url,
        status: response.status,
        contentType,
        bodyLength: body.length,
        bodyPreview: /json|text|javascript|html|xml/i.test(contentType) ? body.slice(0, 5000) : '',
      };
    })
    .slice(-300);
}

function summarizeReport(pageState, responses) {
  const text = norm(pageState.text);
  const totalsMatch = text.match(/TOTALS\s+(\$[0-9,.]+)\s+(\$[0-9,.]+)\s+(\$[0-9,.]+)\s+(\$[0-9,.]+)/i);
  const campaigns = [];
  for (const row of pageState.rows || []) {
    const rowText = norm(row.text);
    if (!/Search Results|\$\d|Campaign end date reached|Paused|Running|Ended/i.test(rowText)) continue;
    if (/TOTALS|Copyright|Terms of Service/i.test(rowText)) continue;
    campaigns.push(rowText);
  }
  return {
    url: pageState.url,
    title: pageState.title,
    totals: totalsMatch ? totalsMatch.slice(1) : [],
    campaignRows: campaigns.slice(0, 40),
    dateControls: (pageState.controls || []).filter((control) => /date|time|calendar|range|UTC|\d{4}|\d{1,2}\/\d{1,2}/i.test([
      control.text,
      control.ariaLabel,
      control.title,
      control.placeholder,
      control.value,
      control.className,
      control.name,
      control.id,
    ].join(' '))).slice(0, 80),
    reportControls: (pageState.controls || []).filter((control) => /report|filter|view|column|download|export|campaign|spend|impression|tap|install/i.test([
      control.text,
      control.ariaLabel,
      control.title,
      control.placeholder,
      control.value,
      control.className,
      control.name,
      control.id,
    ].join(' '))).slice(0, 120),
    relevantResponseCount: responses.length,
    relevantResponseUrls: [...new Set(responses.map((response) => response.url))].slice(-120),
  };
}

function summarizeGraphqlRequests(requests) {
  return requests.map((request) => {
    let parsed = null;
    try {
      parsed = JSON.parse(request.postData || '{}');
    } catch {}
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return {
      ts: request.ts,
      method: request.method,
      url: request.url,
      operations: rows.map((row) => ({
        operationName: row.operationName,
        variables: row.variables,
        queryPreview: String(row.query || '').replace(/\s+/g, ' ').slice(0, 500),
      })),
    };
  });
}

function summarizeGraphqlResponses(responses) {
  return responses.map((response) => {
    let parsed = null;
    try {
      parsed = JSON.parse(response.body || '{}');
    } catch {}
    return {
      ts: response.ts,
      method: response.method,
      url: response.url,
      status: response.status,
      contentType: response.contentType,
      bodyLength: response.body.length,
      keys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : [],
      preview: response.body.slice(0, 2000),
    };
  });
}

function getCampaignReportPayload(requests) {
  for (const request of requests.slice().reverse()) {
    try {
      const parsed = JSON.parse(request.postData || '{}');
      if (parsed?.operationName === 'getReportsByCampaign' && parsed?.query && parsed?.variables?.reportOptions?.filter) {
        return parsed;
      }
    } catch {}
  }
  return null;
}

async function fetchExactCampaignReports(page, templatePayload, ranges) {
  if (!templatePayload || !ranges.length) return [];
  return await page.evaluate(async ({ templatePayload, ranges }) => {
    const outputs = [];
    for (const range of ranges) {
      const payload = JSON.parse(JSON.stringify(templatePayload));
      payload.variables.reportOptions.filter.startTime = range.startTime;
      payload.variables.reportOptions.filter.endTime = range.endTime;
      payload.variables.reportOptions.filter.returnGrandTotals = true;
      payload.variables.reportOptions.filter.returnRowTotals = true;
      payload.variables.reportOptions.filter.selector = payload.variables.reportOptions.filter.selector || {};
      payload.variables.reportOptions.filter.selector.pagination = { offset: 0, limit: 100 };
      const res = await fetch('/reporting/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await res.text();
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {}
      outputs.push({
        label: range.label,
        startTime: range.startTime,
        endTime: range.endTime,
        status: res.status,
        ok: res.ok,
        body,
        json,
      });
    }
    return outputs;
  }, { templatePayload, ranges });
}

function moneyAmount(value) {
  return Number(value?.amount ?? value ?? 0) || 0;
}

function summarizeExactReports(exactReports) {
  return exactReports.map((report) => {
    const data = report.json?.data?.reportingV5?.getReportsByCampaign;
    const grand = data?.grandTotals?.total || {};
    return {
      label: report.label,
      startTime: report.startTime,
      endTime: report.endTime,
      ok: report.ok,
      status: report.status,
      totalResults: data?.pagination?.totalResults ?? null,
      totals: {
        spend: moneyAmount(grand.localSpend),
        currency: grand.localSpend?.currency || 'USD',
        impressions: Number(grand.impressions || 0),
        taps: Number(grand.taps || 0),
        installs: Number(grand.totalInstalls || 0),
        newDownloads: Number(grand.totalNewDownloads || 0),
        redownloads: Number(grand.totalRedownloads || 0),
        avgCPT: moneyAmount(grand.avgCPT),
        avgCPM: moneyAmount(grand.avgCPM),
        avgCPI: moneyAmount(grand.totalAvgCPI),
        ttr: Number(grand.ttr || 0),
        installRate: Number(grand.totalInstallRate || 0),
      },
      campaigns: (data?.row || []).map((row) => ({
        campaignId: row.metadata?.campaignId,
        campaignName: row.metadata?.campaignName,
        displayStatus: row.metadata?.displayStatus,
        servingStateReasons: row.metadata?.servingStateReasons || [],
        startDate: row.metadata?.startDate,
        endDate: row.metadata?.endDate,
        dailyBudget: moneyAmount(row.metadata?.dailyBudget),
        currency: row.metadata?.dailyBudget?.currency || 'USD',
        countriesOrRegions: row.metadata?.countriesOrRegions || [],
        supplySources: row.metadata?.supplySources || [],
        spend: moneyAmount(row.total?.localSpend),
        impressions: Number(row.total?.impressions || 0),
        taps: Number(row.total?.taps || 0),
        installs: Number(row.total?.totalInstalls || 0),
        newDownloads: Number(row.total?.totalNewDownloads || 0),
        redownloads: Number(row.total?.totalRedownloads || 0),
        avgCPT: moneyAmount(row.total?.avgCPT),
        avgCPM: moneyAmount(row.total?.avgCPM),
        avgCPI: moneyAmount(row.total?.totalAvgCPI),
        ttr: Number(row.total?.ttr || 0),
        installRate: Number(row.total?.totalInstallRate || 0),
      })),
    };
  });
}

async function keepOpen(session) {
  if (CLOSE_AFTER_HARVEST) {
    await session.close().catch(() => {});
    return;
  }

  if (KEEP_OPEN_AFTER_HARVEST_MS > 0) {
    console.log(`[apple-ads-report-harvest] keeping browser open for ${KEEP_OPEN_AFTER_HARVEST_MS}ms`);
    await session.page.waitForTimeout(KEEP_OPEN_AFTER_HARVEST_MS).catch(() => {});
    return;
  }

  console.log('[apple-ads-report-harvest] keeping browser open; set APPLE_ADS_CLOSE_AFTER_HARVEST=1 to close automatically');
  await new Promise(() => {});
}

async function main() {
  const acct = await getSocialAccount('apple');
  if (!acct) {
    console.log('FAIL: no active apple account in DB');
    process.exit(1);
  }

  const { proxyUrl } = await resolveAccountSession(acct);
  const persona = stableProfilePersona();
  const s = await WSession.start({
    label: SESSION_LABEL,
    browser: process.env.BROWSER || 'chromium',
    proxy: proxyUrl ?? (process.env.PROXY_URL || 'direct'),
    persona,
    userDataDir: USER_DATA_DIR,
    record: false,
    pageDiagnostics: false,
  });

  let exitCode = 0;
  try {
    const network = installNetworkCapture(s.page);
    const firstNav = await gotoAndWait(s.page, REPORT_URL);
    if (!firstNav && (s.page.url?.() || '') === 'about:blank') {
      console.log('[apple-ads-report-harvest] first navigation stayed blank; retrying');
      await gotoAndWait(s.page, REPORT_URL);
    }
    console.log(`[apple-ads-report-harvest] before login check url=${s.page.url?.() || ''}`);
    const loggedIn = await requireAuthenticatedSession(s);
    console.log(`[apple-ads-report-harvest] login check loggedIn=${loggedIn} url=${s.page.url?.() || ''}`);
    if (!loggedIn) {
      exitCode = 2;
      return;
    }
    await s.saveCookies().catch(() => null);
    if (!/\/report/i.test(s.page.url?.() || '')) {
      await gotoAndWait(s.page, REPORT_URL);
    } else {
      await s.page.waitForTimeout(WAIT_AFTER_NAV_MS).catch(() => {});
    }
    if (!await ensureReportPage(s.page)) {
      const currentUrl = s.page.url?.() || '';
      console.log(`FAIL: Apple Ads report page not loaded (${currentUrl})`);
      exitCode = 4;
      return;
    }
    const protectedUrl = new URL(s.page.url?.() || 'about:blank');
    const protectedText = await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const protectedMarker = protectedText.match(/Manage Your Campaigns|Reporting is not in real time|Create Campaign|Campaign end date reached/i)?.[0];
    const authenticatedProtectedPage = protectedUrl.hostname === 'app-ads.apple.com'
      && !/signin|login/i.test(protectedUrl.pathname)
      && /\/report(?:\/|$)/i.test(protectedUrl.pathname)
      && Boolean(protectedMarker);
    if (!authenticatedProtectedPage) {
      console.log('FAIL_CLOSED: authenticated Apple Ads report page was not confirmed; run an explicitly authorized apple_login before retrying.');
      exitCode = 4;
      return;
    }

    const snapshots = [];
    const current = await collectPageState(s.page);
    snapshots.push({
      label: 'initial',
      click: null,
      page: current,
      summary: summarizeReport(current, sanitizeResponses(s.capturedResponses || [])),
    });

    for (const preset of DATE_PRESETS) {
      const click = await clickDatePreset(s.page, preset);
      await s.page.waitForTimeout(WAIT_AFTER_NAV_MS).catch(() => {});
      const page = await collectPageState(s.page);
      snapshots.push({
        label: preset,
        click,
        page,
        summary: summarizeReport(page, sanitizeResponses(s.capturedResponses || [])),
      });
    }

    await s.page.waitForTimeout(1000).catch(() => {});
    const templatePayload = getCampaignReportPayload(network.requests);
    const exactReports = await fetchExactCampaignReports(s.page, templatePayload, EXACT_RANGES);
    const exactSummary = summarizeExactReports(exactReports);
    const responses = sanitizeResponses(s.capturedResponses || []);
    const observedRequests = network.requests.slice();
    const observedResponses = network.responses.slice();
    const summary = {
      initial: snapshots[0].summary,
      presets: snapshots.slice(1).map((snapshot) => ({
        label: snapshot.label,
        click: snapshot.click,
        summary: snapshot.summary,
      })),
      graphqlRequests: summarizeGraphqlRequests(observedRequests).slice(-40),
      graphqlResponses: summarizeGraphqlResponses(observedResponses).slice(-40),
      exactReports: exactSummary,
    };
    const output = {
      ok: true,
      reportUrl: REPORT_URL,
      capturedAt: new Date().toISOString(),
      snapshots,
      responses,
      observedRequests,
      observedResponses,
      exactReports,
      summary,
    };
    const outPath = join(DIAG_DIR, 'report_harvest.json');
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    await s.saveCookies().catch(() => null);
    console.log(`[apple-ads-report-harvest] json=${outPath}`);
    console.log(JSON.stringify(summary, null, 2).slice(0, 12000));
  } finally {
    process.exitCode = exitCode;
    await keepOpen(s);
  }
}

main().catch((error) => {
  console.log('FAIL:', error.message?.slice(0, 1000) || String(error));
  process.exit(1);
});
