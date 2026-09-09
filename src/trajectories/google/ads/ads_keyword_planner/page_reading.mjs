// Reading the page and the wire: what the planner endpoints answered, and
// what the rendered surface shows.
//
// Moved verbatim during a split by responsibility, with the two silent
// listeners repaired: a capture that threw used to disappear, so a run could
// report an empty wire summary while the reason it was empty was thrown away.
// The DOM snapshot no longer answers with an empty page either — a page that
// cannot be read is a failure, not a page with no text.

import { keywords, norm } from './request.mjs';

export function installKeywordPlannerCapture(page) {
  const requests = [];
  const responses = [];
  page.on('request', (request) => {
    try {
      const url = request.url();
      if (!/ads\.google\.com/i.test(url)) return;
      if (!/(keyword|planner|idea|forecast|plan|targeting|batch|rpc|AwAdsGuide)/i.test(url)) return;
      const headers = request.headers();
      requests.push({
        ts: Date.now(),
        method: request.method(),
        url,
        postData: String(request.postData() || '').slice(0, 1000000),
        replayHeaders: {
          'x-framework-xsrf-token': headers['x-framework-xsrf-token'] || '',
          'x-same-domain': headers['x-same-domain'] || '',
        },
      });
      if (requests.length > 300) requests.shift();
    } catch (error) {
      console.log(`[google-ads-keyword-planner] WARN: request capture failed ${String(error?.message || error).slice(0, 240)}`);
    }
  });
  page.on('response', (response) => {
    void (async () => {
      try {
        const url = response.url();
        if (!/ads\.google\.com/i.test(url)) return;
        if (!/(keyword|planner|idea|forecast|plan|targeting|batch|rpc|AwAdsGuide)/i.test(url)) return;
        const headers = response.headers();
        const contentType = String(headers['content-type'] || '');
        let body = '';
        if (/json|text|javascript|html|xml|x-www-form-urlencoded/i.test(contentType)) {
          body = (await response.text()).slice(0, 1000000);
        }
        const parsedUrl = new URL(url);
        responses.push({
          ts: Date.now(),
          method: response.request()?.method?.() || 'GET',
          endpoint: `${parsedUrl.origin}${parsedUrl.pathname}`,
          status: response.status(),
          contentType,
          body,
        });
        if (responses.length > 300) responses.shift();
      } catch (error) {
        console.log(`[google-ads-keyword-planner] WARN: response capture failed ${String(error?.message || error).slice(0, 240)}`);
      }
    })();
  });
  return { requests, responses };
}

function stripJsonPrefix(text) {
  return String(text || '').replace(/^\)\]\}'\s*\n?/, '');
}

/// `null` says the body is not JSON, which is an answer about the body rather
/// than a failure of this read.
function parseJson(text) {
  try {
    return JSON.parse(stripJsonPrefix(text));
  } catch {
    return null;
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function walk(value, visit, path = []) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, path.concat(String(index))));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) walk(child, visit, path.concat(key));
  }
}

export function summarizeKeywordPlannerResponses(responses) {
  const endpointCounts = {};
  const keywordMentions = [];
  const metricsMentions = [];
  const numericMentions = [];
  const keywordPatterns = keywords.map((keyword) => new RegExp(keyword.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i'));

  for (const response of responses) {
    const endpointName = response.endpoint.split('/').slice(-3).join('/');
    endpointCounts[endpointName] = (endpointCounts[endpointName] || 0) + 1;
    const parsed = parseJson(response.body);
    if (!parsed) continue;
    walk(parsed, (value, path) => {
      if (typeof value === 'string') {
        const compact = norm(value);
        if (!compact || compact.length > 300) return;
        if (keywordPatterns.some((pattern) => pattern.test(compact))) {
          keywordMentions.push({ endpoint: endpointName, path: path.join('.'), value: compact });
        }
        if (/avg|monthly|search|competition|bid|forecast|click|impression|volume/i.test(compact)) {
          metricsMentions.push({ endpoint: endpointName, path: path.join('.'), value: compact });
        }
      }
      if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
        numericMentions.push({ endpoint: endpointName, path: path.join('.'), value });
      }
    });
  }

  return {
    responseCount: responses.length,
    endpointCounts,
    keywordMentions: keywordMentions.slice(0, 200),
    metricsMentions: metricsMentions.slice(0, 200),
    numericMentions: numericMentions.slice(0, 300),
  };
}

export async function collectDom(page) {
  return await page.evaluate(() => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const nodes = [];
    const seen = new Set();
    const visit = (root) => {
      for (const el of root.querySelectorAll?.('*') || []) {
        if (seen.has(el)) continue;
        seen.add(el);
        nodes.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    const rows = nodes
      .filter((el) => visible(el) && (/^(tr|material-list-item)$/i.test(el.tagName || '') || el.getAttribute?.('role') === 'row'))
      .map((row) => norm(row.innerText || row.textContent || ''))
      .filter(Boolean)
      .slice(0, 300);
    const controls = nodes
      .filter((el) => visible(el) && (/^(a|button|input|textarea|material-button)$/i.test(el.tagName || '') || /button|menuitem|textbox/i.test(el.getAttribute?.('role') || '') || el.getAttribute?.('aria-label')))
      .map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute?.('role') || '',
        text: norm(el.innerText || el.textContent || '').slice(0, 300),
        aria: el.getAttribute?.('aria-label') || '',
        title: el.getAttribute?.('title') || '',
        placeholder: el.getAttribute?.('placeholder') || '',
        value: norm(el.value || '').slice(0, 300),
      }))
      .filter((control) => /keyword|planner|search|forecast|volume|result|product|service|website|language|location|competition|bid|start|get|discover/i.test(`${control.text} ${control.aria} ${control.title} ${control.placeholder} ${control.value}`))
      .slice(0, 300);
    return {
      url: location.href,
      title: document.title,
      text: norm(document.body?.innerText || ''),
      rows,
      controls,
    };
  });
}
