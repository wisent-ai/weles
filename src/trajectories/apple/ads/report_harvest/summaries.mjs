// The captured responses and requests, reduced to what the report says.
import { norm } from './session.mjs';

export function responseIsRelevant(response) {
  return /app-ads\.apple\.com|searchads|report|campaign|budget|spend|analytics|api/i.test(response.url || '');
}

export function sanitizeResponses(responses) {
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

export function summarizeReport(pageState, responses) {
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

export function summarizeGraphqlRequests(requests) {
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

export function summarizeGraphqlResponses(responses) {
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

export function getCampaignReportPayload(requests) {
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
