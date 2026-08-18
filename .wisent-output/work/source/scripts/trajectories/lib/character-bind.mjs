// Binds a freshly registered social account to an existing Weles character.
// Character creation is intentionally outside this module: cross-product
// generation routes and shared product secrets are not valid Weles boundaries.

export async function autoBindCharacter(username, platform) {
  const url = process.env.WELES_DATABASE_URL ?? '';
  const key = process.env.WELES_DATABASE_TOKEN ?? '';
  if (!url || !key) return { status: 'no_creds' };
  const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const acctRes = await fetch(`${url}/rest/v1/social_accounts?platform=eq.${platform}&username=eq.${encodeURIComponent(username)}&select=id&limit=1`, { headers: H });
  const acctRows = await acctRes.json().catch(() => []);
  const accountId = acctRows?.[0]?.id;
  if (!accountId) return { status: 'account_not_found' };

  const arrFilter = encodeURIComponent(`{"${platform}"}`);
  const candRes = await fetch(`${url}/rest/v1/characters?is_active=eq.true&platforms=cs.${arrFilter}&select=id,name&order=created_at.asc&limit=500`, { headers: H });
  let candidates = await candRes.json().catch(() => []);

  // Find an unbound candidate. The taken-check filters out characters that
  // already have a social_account on this platform.
  async function pickUnbound(list) {
    for (const cand of list) {
      const linkRes = await fetch(`${url}/rest/v1/character_social_accounts?character_id=eq.${cand.id}&select=social_accounts(platform)`, { headers: H });
      const links = await linkRes.json().catch(() => []);
      const taken = (Array.isArray(links) ? links : []).some((l) => l?.social_accounts?.platform === platform);
      if (!taken) return cand;
    }
    return null;
  }

  let pick = Array.isArray(candidates) && candidates.length ? await pickUnbound(candidates) : null;

  if (!pick) return { status: 'no_unbound_character', platform };

  const ins = await fetch(`${url}/rest/v1/character_social_accounts`, {
    method: 'POST',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ character_id: pick.id, social_account_id: accountId }),
  });
  if (ins.ok) return { status: 'bound', character_id: pick.id, character_name: pick.name };
  return { status: 'bind_failed', platform };
}
