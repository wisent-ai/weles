// Auto-bind a freshly registered social_account to a character whose
// `platforms` array includes the target platform AND that has no existing
// social_account on that platform. Imported by every <platform>_register.mjs
// trajectory immediately after WSession.saveAccount returns. Without this
// step, action trajectories (organic_comment, post, post_promote, promote)
// abort at _shared/action-runner.mjs:80 with FAIL: no character linked.
// `_shared/` and `_shared/services/` were both at file-count cap, so this
// helper lives in a sibling lib/ directory at the trajectories root.

export async function autoBindCharacter(username, platform) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return { status: 'no_creds' };
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const acctRes = await fetch(`${url}/rest/v1/social_accounts?platform=eq.${platform}&username=eq.${encodeURIComponent(username)}&select=id&limit=1`, { headers: H });
  const acctRows = await acctRes.json().catch(() => []);
  const accountId = acctRows?.[0]?.id;
  if (!accountId) return { status: 'account_not_found' };

  const arrFilter = encodeURIComponent(`{"${platform}"}`);
  // FIFO by created_at: bind the oldest unbound character first so the
  // queue drains naturally as new social_accounts come in. Limit 500
  // covers any reasonable fleet size (current ecosystem ~150 chars,
  // headroom for 3-4x growth before pagination becomes necessary).
  // Previous limit=20 + desc ordering meant: in any fleet >20 active chars
  // on a platform, the older ones below the 20-newest cutoff would never
  // be picked even if unbound — the helper would return 'all_taken' for
  // them prematurely.
  const candRes = await fetch(`${url}/rest/v1/characters?is_active=eq.true&platforms=cs.${arrFilter}&select=id,name&order=created_at.asc&limit=500`, { headers: H });
  const candidates = await candRes.json().catch(() => []);
  if (!Array.isArray(candidates) || candidates.length === 0) return { status: 'no_character_for_platform', platform };

  for (const cand of candidates) {
    const linkRes = await fetch(`${url}/rest/v1/character_social_accounts?character_id=eq.${cand.id}&select=social_accounts(platform)`, { headers: H });
    const links = await linkRes.json().catch(() => []);
    const taken = (Array.isArray(links) ? links : []).some((l) => l?.social_accounts?.platform === platform);
    if (taken) continue;
    const ins = await fetch(`${url}/rest/v1/character_social_accounts`, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ character_id: cand.id, social_account_id: accountId }),
    });
    if (ins.ok) return { status: 'bound', character_id: cand.id, character_name: cand.name };
  }
  return { status: 'all_taken', platform };
}
