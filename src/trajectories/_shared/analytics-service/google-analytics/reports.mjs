import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { GA_BASE, input, actionName, actionUrl } from '../action-catalog.mjs';
import { waitRendered, clickFirst, clickCardLike } from '../page-interaction.mjs';
import { openDataStreamDetail } from './web-stream.mjs';

function propertyRoute(section = 'reports') {
  const propertyId = input('PROPERTY_ID');
  if (!propertyId) return GA_BASE;
  return `${GA_BASE}#/p${propertyId}/${section}`;
}

function resolvedUrl(cfg) {
  const action = actionName();
  if (cfg.platform === 'googleanalytics') {
    if (action.includes('realtime')) return propertyRoute('realtime');
    if (action.includes('debugview')) return propertyRoute('admin/debugview');
    if (action === 'googleanalytics_get_global_site_tag') {
      const streamId = input('STREAM_ID');
      return streamId && streamId !== 'unknown-stream'
        ? propertyRoute(`admin/streams/table/${streamId}`)
        : propertyRoute('admin/streams/table');
    }
    if (action.includes('acquisition')) return propertyRoute('reports/acquisition');
    if (action.includes('engagement')) return propertyRoute('reports/engagement');
    if (action.includes('pages')) return propertyRoute('reports/engagement/pages-and-screens');
    if (action === 'googleanalytics_export_report') return propertyRoute('reports/engagement/pages-and-screens');
    if (action.includes('key_event')) return propertyRoute('admin/events/key-events');
    if (action.includes('audience')) return propertyRoute('admin/audiences');
    if (action.includes('custom_dimension') || action.includes('custom_metric')) return propertyRoute('admin/custom-definitions');
    if (action.includes('data_retention')) return propertyRoute('admin/data-retention');
    return actionUrl(cfg);
  }
  return actionUrl(cfg);
}

async function openExpectedDashboardSection(s) {
  const action = actionName();
  if (action === 'googleanalytics_view_realtime' || action === 'googleanalytics_verify_realtime') {
    await clickFirst(s.page, [/^View real time$/i, /^Realtime$/i, /^Real-time$/i]);
    await humanIdlePause('long');
    return;
  }
  const paths = {
    googleanalytics_view_acquisition: [/^Reports$/i, /^Acquisition$/i],
    googleanalytics_view_engagement: [/^Reports$/i, /^Engagement$/i],
    googleanalytics_view_pages: [/^Reports$/i, /^Engagement$/i, /^Pages and screens$/i],
    googleanalytics_export_report: [/^Reports$/i, /^Engagement$/i, /^Pages and screens$/i],
    googleanalytics_view_key_events: [/^Admin$/i, /^Events$/i],
    googleanalytics_view_debugview: [/^Admin$/i, /^DebugView$/i],
    googleanalytics_get_global_site_tag: [/^Admin$/i, /^Data streams$/i],
  };
  const path = paths[action];
  if (!path) return;
  for (const label of path) {
    const clicked = await clickFirst(s.page, [label]);
    if (!clicked) await clickCardLike(s.page, label);
    await waitRendered(s.page, 30);
    if (action === 'googleanalytics_view_key_events' && /Events/i.test(String(label)) && /\/admin$/.test(s.page.url())) {
      await clickCardLike(s.page, label);
      await waitRendered(s.page, 30);
    }
    if (action === 'googleanalytics_get_global_site_tag' && /Data streams/i.test(String(label)) && /\/admin$/.test(s.page.url())) {
      await clickCardLike(s.page, label);
      await waitRendered(s.page, 30);
    }
    await humanIdlePause('deliberate');
  }
  if (action === 'googleanalytics_get_global_site_tag') {
    await openDataStreamDetail(s);
    await waitRendered(s.page, 30);
    await clickFirst(s.page, [/View tag instructions/i, /Tag instructions/i, /^Google tag$/i]);
    await waitRendered(s.page, 30);
  }
}

export {
  propertyRoute,
  resolvedUrl,
  openExpectedDashboardSection,
};
