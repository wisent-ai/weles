// The exact-range campaign reports fetched through the page's own session, and the keep-open tail.
import { CLOSE_AFTER_HARVEST, KEEP_OPEN_AFTER_HARVEST_MS } from './settings.mjs';

export async function fetchExactCampaignReports(page, templatePayload, ranges) {
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

export function moneyAmount(value) {
  return Number(value?.amount ?? value ?? 0) || 0;
}

export function summarizeExactReports(exactReports) {
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

export async function keepOpen(session) {
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
