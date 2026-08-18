// PerimeterX localStorage persistence for LinkedIn.
//
// Diff harness 2026-05-03 (.work/inst/linkedin_login_diff_2026-05-03T21-02-42-556Z.md
// lines 25-30) shows chrome's session reads PXdOjV695v__pxvid count=2 and writes
// PXdOjV695v_px_hvd count=2, while weles reads/writes neither — meaning chrome
// has a CACHED PerimeterX visitor identity from prior visits. weles starts fresh
// every session, so PX treats us as a brand-new visitor on a residential proxy
// and challenges by default (3 POSTs to /Aa2cBLc-islKN9O per session, plus 1
// to /sensorCollect/?action=reportMetrics). Persisting these keys across
// sessions makes PX recognize the account as a returning visitor.
//
// Keys captured (matched by single regex):
//   PXdOjV695v_*  — PerimeterX visitor id, fingerprint, high-value-detection
//   pxsid         — PX session id
//   _pxvid        — alternate visitor-id key (some PX deployments)
//   px_* / _px_*  — PX cookie-mirror keys (px_ssd, _px_acp, etc.)
//   rc::*         — reCAPTCHA Enterprise client state
//   _grecaptcha   — grecaptcha enterprise marker

const PX_LS_KEY_RE = /^(PXdOjV695v_|_pxvid|pxsid|_?px_|rc::|_grecaptcha)/;

export async function captureLinkedinPxStorage(s, acct) {
  if (!acct?.id) return { ok: false, reason: 'no_acct_id' };
  try {
    const items = await s.page.evaluate((reSrc) => {
      const re = new RegExp(reSrc);
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && re.test(k)) out[k] = localStorage.getItem(k);
        }
      } catch {}
      return out;
    }, PX_LS_KEY_RE.source).catch(() => ({}));
    const keyCount = Object.keys(items).length;
    if (!keyCount) { console.log('[linkedin_login] no PX localStorage to persist'); return { ok: false, reason: 'empty' }; }
    console.log(`[linkedin_login] persisting ${keyCount} PX localStorage keys`);
    const url = process.env.WELES_DATABASE_URL ?? '';
    const key = process.env.WELES_DATABASE_TOKEN ?? '';
    if (!url || !key) return { ok: false, reason: 'no_supabase_env' };
    const merged = { ...((acct.metadata ?? {})), linkedin_px_storage: items, linkedin_px_storage_at: new Date().toISOString() };
    const res = await fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: merged }),
    });
    if (!res.ok) return { ok: false, reason: `patch_${res.status}` };
    acct.metadata = merged;
    return { ok: true, count: keyCount };
  } catch (e) { console.log('[linkedin_login] capture px-ls err:', e.message); return { ok: false, reason: e.message }; }
}

export async function restoreLinkedinPxStorage(s, acct) {
  const stored = acct?.metadata?.linkedin_px_storage;
  if (!stored || typeof stored !== 'object') return { ok: false, reason: 'no_stored' };
  const keys = Object.keys(stored);
  if (!keys.length) return { ok: false, reason: 'empty_stored' };
  try {
    await s.page.evaluate(({ kv }) => {
      try { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, String(v)); } catch {}
    }, { kv: stored });
    console.log(`[linkedin_login] restored ${keys.length} PX localStorage keys (cached _pxvid skips PX cold-start challenge)`);
    return { ok: true, count: keys.length };
  } catch (e) { console.log('[linkedin_login] restore px-ls err:', e.message); return { ok: false, reason: e.message }; }
}
