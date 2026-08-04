// Auto-bind a freshly registered social_account to a character. If no
// eligible character exists for the platform, auto-generate one inline
// using the LLM proxy + Supabase service role, then bind. End-to-end
// automatic — no UI click required.
//
// Imported by every <platform>_register.mjs trajectory immediately after
// WSession.saveAccount returns. Without this step (or with bind-only and
// no character pool), action trajectories abort at _shared/action-runner.mjs:80
// with FAIL: no character linked.

// Typology spans every register-able social platform. Drives both the
// generation prompt (serious vs unserious) and the platforms array
// stamped on the new character row so one persona spans its full bucket.
const SERIOUS_PLATFORM_SET = ['linkedin', 'producthunt', 'github'];
const UNSERIOUS_CONSUMER = ['instagram', 'tiktok', 'snapchat'];
const UNSERIOUS_SOCIAL = ['twitter', 'reddit', 'discord', 'youtube'];
const UNSERIOUS_PLATFORM_SET = [...UNSERIOUS_CONSUMER, ...UNSERIOUS_SOCIAL];
const TYPOLOGY = Object.fromEntries([
  ...SERIOUS_PLATFORM_SET.map((p) => [p, { type: 'serious',   platforms: SERIOUS_PLATFORM_SET }]),
  ...UNSERIOUS_PLATFORM_SET.map((p) => [p, { type: 'unserious', platforms: UNSERIOUS_PLATFORM_SET }]),
]);

const LLM_API_URL = process.env.LLM_API_URL || 'https://api.wisentmedia.com/api/llm/messages';

const SYSTEM_SERIOUS = `You are designing a "serious" tech persona for a multi-platform automated social presence. Hard constraints — every output MUST satisfy these:

1. home_city is exactly one of: "San Francisco" OR "New York"
2. home_country is "US"
3. occupation is one of: a venture capitalist (VC at a named-tier firm), a founder (current company, stage-specific), or an employee of a prestigious tech organization (current role + company)
4. The persona will operate accounts on linkedin AND producthunt simultaneously — the voice has to read as authentic on both

Return ONLY valid JSON:
{"name":"","gender":"female|male|non_binary","age":<int 26-50>,"nationality":"","occupation":"Specific role + organization. Pick the organization yourself.","niche":"lower_snake_case slug","bio":"2-3 short paragraphs first person","personality":"1-2 sentences","communication_style":"concrete dos-and-donts","interests":["5-7"],"values":["3-4"],"home_city":"San Francisco" or "New York","home_country":"US","weekly_routine":{"comments_per_week":<int>,"posts_per_week":<int>,"connections_per_week":<int>}}`;

const SYSTEM_UNSERIOUS = `You are designing an "unserious" creator persona for a multi-platform automated social presence (instagram + tiktok). The character is a niche-driven creator in the mold of:
- Isabella Reyes — 24, female, wellness/yoga, Medellin → Miami
- Mei Lin Chen — 23, female, alternative fashion, Taipei → Tokyo → LA
- Soo-yeon Park — 21, female, K-beauty, Seoul university student
- Natasha Orlova — 24, female, dance/ballet, Saint Petersburg → NYC
New characters fit the same MOLD: young, niche-specific creator, international/aspirational location, content-creator energy.

Return ONLY valid JSON:
{"name":"","gender":"female|male|non_binary","age":<int 19-30>,"nationality":"","niche":"","bio":"1-2 short paragraphs same shape as references","personality":"1-2 sentences in reference style","communication_style":"how they post and caption","interests":["5-7"],"values":["3-4"],"home_city":"","home_country":"","weekly_routine":{"posts_per_week":<int>,"stories_per_week":<int>,"comments_per_week":<int>}}`;

async function generateCharacter(_supabaseUrl, _serviceKey, platform) {
  // 2026-05-06: api.wisentmedia.com decommissioned. Delegate to the
  // Echo /api/characters/generate route which uses the same
  // Claude-via-OAuth client as the UI and writes the characters row +
  // character_states server-side. Auth via x-cron-secret matches the
  // /api/llm/generate cron-flow pattern. Keeps prompt + insert logic in
  // one place (route.ts) so future schema changes don't drift between
  // Weles and Echo.
  const t = TYPOLOGY[platform];
  if (!t) return null;
  const charGenUrl = process.env.CHARACTER_GENERATE_URL || 'https://api.echo.wisent.ai/api/characters/generate';
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) { console.log('[char-gen] CRON_SECRET not set in env'); return null; }
  const res = await fetch(charGenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
    body: JSON.stringify({ type: t.type }),
  }).catch((e) => { console.log(`[char-gen] fetch err: ${e?.message?.slice(0, 80)}`); return null; });
  if (!res) return null;
  if (!res.ok) { console.log(`[char-gen] route returned ${res.status}`); return null; }
  let body; try { body = await res.json(); } catch { return null; }
  return body?.character ?? null;
}

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

  // No eligible character anywhere — auto-generate one inline. Only works
  // for typed platforms (linkedin, producthunt, instagram, tiktok). For
  // untyped platforms we still return no_character_for_platform.
  if (!pick && (!Array.isArray(candidates) || candidates.length === 0)) {
    const generated = await generateCharacter(url, key, platform);
    if (!generated) return { status: 'no_character_for_platform', platform };
    pick = { id: generated.id, name: generated.name };
  }

  // All candidates taken — also generate a fresh one for typed platforms.
  if (!pick) {
    const generated = await generateCharacter(url, key, platform);
    if (!generated) return { status: 'all_taken', platform };
    pick = { id: generated.id, name: generated.name };
  }

  const ins = await fetch(`${url}/rest/v1/character_social_accounts`, {
    method: 'POST',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ character_id: pick.id, social_account_id: accountId }),
  });
  if (ins.ok) return { status: 'bound', character_id: pick.id, character_name: pick.name };
  return { status: 'bind_failed', platform };
}
