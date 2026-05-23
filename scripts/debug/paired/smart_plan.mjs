// Smart-plan domain re-pinning for --vary=ip experiments.
//
// The burn-attribution matcher pairs rows by (same domain, different IP,
// opposite outcome). When --vary=ip, the most useful hold-domain is the one
// with the broadest existing-failure coverage across the planned proxies, so
// every prior static-ISP failure becomes reusable evidence.

export async function repinPlanDomain({ supabaseUrl, supabaseKey, action, plan, holdDomain, freshnessHours }) {
  const sinceIso = new Date(Date.now() - freshnessHours * 3600 * 1000).toISOString();
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const proxies = [...new Set(plan.map((p) => p.proxy))];
  const coverage = {};
  for (const proxy of proxies) {
    const qp = new URLSearchParams();
    qp.set('select', 'params,status,completed_at');
    qp.set('action', `eq.${action}`);
    qp.set('params->>proxy_url_override', `eq.${proxy}`);
    qp.set('status', 'eq.failed');
    qp.set('completed_at', `gte.${sinceIso}`);
    qp.set('limit', '20');
    const r = await fetch(`${supabaseUrl}/rest/v1/account_action_logs?${qp}`, { headers });
    if (!r.ok) continue;
    const rows = await r.json();
    for (const row of rows) {
      const d = row.params?.force_email_domain;
      if (!d) continue;
      if (!coverage[d]) coverage[d] = new Set();
      coverage[d].add(proxy);
    }
  }
  let bestDomain = holdDomain;
  let bestCount = (holdDomain && coverage[holdDomain]?.size) || 0;
  for (const [d, set] of Object.entries(coverage)) {
    if (set.size > bestCount) { bestDomain = d; bestCount = set.size; }
  }
  const changed = bestDomain && bestDomain !== holdDomain;
  const newPlan = changed ? plan.map((p) => ({ ...p, domain: bestDomain })) : plan;
  return { plan: newPlan, holdDomain: bestDomain ?? holdDomain, coverageCount: bestCount, totalProxies: proxies.length, changed };
}
