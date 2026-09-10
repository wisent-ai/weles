// The Google Ads URLs the planner opens and the keyword-planner responses it captures.
import { cid, keywords, norm, normalizeCustomerId } from './settings.mjs';
import { preferredGoogleAdsEmail } from './sign_in.mjs';

export function campaignsUrl(paramName, target, authuser = preferredGoogleAdsEmail()) {
  const url = new URL('https://ads.google.com/aw/campaigns');
  url.searchParams.set(paramName, normalizeCustomerId(target));
  if (authuser) url.searchParams.set('authuser', authuser);
  return url.toString();
}

export function buildGoogleAdsPath(current, pathname) {
  const source = new URL(current || campaignsUrl('cid', cid));
  const target = new URL(pathname, 'https://ads.google.com');
  for (const key of ['ocid', 'authuser', '__u', '__c', 'uscid', 'euid', 'cid', '__e']) {
    const value = source.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  target.searchParams.set('authuser', preferredGoogleAdsEmail());
  if (!target.searchParams.get('cid')) target.searchParams.set('cid', cid);
  return target.toString();
}

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
    } catch {}
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
          body = (await response.text().catch(() => '')).slice(0, 1000000);
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
      } catch {}
    })();
  });
  return { requests, responses };
}

export function stripJsonPrefix(text) {
  return String(text || '').replace(/^\)\]\}'\s*\n?/, '');
}

export function parseJson(text) {
  try {
    return JSON.parse(stripJsonPrefix(text));
  } catch {
    return null;
  }
}

export function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function walk(value, visit, path = []) {
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
