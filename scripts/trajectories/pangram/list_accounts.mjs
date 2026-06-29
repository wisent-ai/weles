// Read-only Pangram account pool diagnostic. Prints non-secret account metadata only.

const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!url || !key) {
  console.log(JSON.stringify({ error: 'missing_supabase_env' }, null, 2));
  process.exit(1);
}

const query = 'platform=eq.pangram&is_active=eq.true&select=id,username,created_at&order=created_at.asc';
const res = await fetch(`${url}/rest/v1/social_accounts?${query}`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});

if (!res.ok) {
  console.log(JSON.stringify({ error: `supabase_${res.status}` }, null, 2));
  process.exit(1);
}

const rows = await res.json().catch(() => []);
console.log(JSON.stringify((Array.isArray(rows) ? rows : []).map((r, i) => ({
  i,
  id: r.id,
  username: r.username,
  created_at: r.created_at,
})), null, 2));
