import { WSession } from '../../../dist/session/wsession.js';

// Upvote a Product Hunt product. Pass PRODUCTHUNT_URL=https://www.producthunt.com/products/<slug>
// to vote on a specific product; otherwise the trajectory upvotes the first product
// card on the homepage.

const TARGET_URL = process.env.PRODUCTHUNT_URL || 'https://www.producthunt.com/';
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
const proxy = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || 'none');
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function findProductHuntAccount() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return null;
  const res = await fetch(
    `${supabaseUrl}/rest/v1/social_accounts?platform=eq.producthunt&is_active=eq.true&select=id,platform,username,metadata&order=created_at.desc&limit=20`,
    { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  for (const a of rows) {
    if (Array.isArray(a.metadata?.cookies) && a.metadata.cookies.length >= 1) return a;
  }
  return rows[0] ?? null;
}

async function injectPHCookies(s, cookies) {
  const normalized = cookies
    .filter(c => c.name && c.value)
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain?.includes('producthunt.com') ? c.domain : '.producthunt.com',
      path: c.path || '/',
      secure: c.secure ?? true,
      httpOnly: c.httpOnly ?? false,
      sameSite: c.sameSite || 'Lax',
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
    }));
  await s.ctx.addCookies(normalized);
  console.log(`[ph-vote] injected ${normalized.length} producthunt cookies`);
}

async function readPage(s) {
  return (await s.page.evaluate(`(() => (document.body?.innerText ?? '').substring(0, 2000))()`).catch(() => '')).toLowerCase();
}

async function navigateToFirstProduct(s) {
  // From the homepage, find the first product card link and follow it.
  // PH uses /products/<slug> for current launches; older URLs are /posts/<slug>.
  // Filter out footer reference links (?ref=footer) since those go to product hubs not the launch page.
  const href = await s.page.evaluate(`(() => {
    var as = Array.from(document.querySelectorAll('a[href*="/products/"], a[href*="/posts/"]'));
    for (var a of as) {
      var h = a.getAttribute('href') || '';
      if (h.includes('?ref=footer')) continue;
      if (h.includes('/reviews')) continue;
      var slug = (h.match(/\\/products\\/([^/?#]+)/) || h.match(/\\/posts\\/([^/?#]+)/) || [])[1];
      if (slug) return h;
    }
    return null;
  })()`).catch(() => null);
  if (!href) return false;
  const url = href.startsWith('http') ? href : new URL(href, 'https://www.producthunt.com').toString();
  console.log(`[ph-vote] following first product: ${url}`);
  await s.goto(url);
  await sleep(4);
  return true;
}

async function findVoteButton(s) {
  // PH has two distinct vote button shapes:
  //   * data-test="vote-button"            — inline launch leaderboard (clickable, increments)
  //   * data-test="action-bar-vote-button" — product hub (one per historical launch, navigates)
  // Prefer the launch leaderboard button. Skip product-hub buttons (text "Upvote (N)").
  return await s.page.evaluate(`(() => {
    function rect(el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height } : null; }
    var preferred = [
      'button[data-test="vote-button"]',
      'button[data-test*="vote-button"]:not([data-test*="action-bar"]):not([data-test*="thread"])',
      'button[aria-label*="Upvote" i]',
      'button[aria-label*="Vote" i]',
    ];
    for (var sel of preferred) {
      var b = document.querySelector(sel);
      if (b) { var r = rect(b); if (r) return { ...r, sel: sel, label: (b.getAttribute('aria-label') || b.textContent || '').slice(0, 60) }; }
    }
    // Last resort: action-bar (product hub — won't increment but at least confirms we found something)
    var ab = document.querySelector('button[data-test="action-bar-vote-button"]');
    if (ab) { var r2 = rect(ab); if (r2) return { ...r2, sel: 'action-bar-vote-button', label: (ab.textContent || '').slice(0, 60) }; }
    return null;
  })()`).catch(() => null);
}

async function readVoteState(s) {
  return await s.page.evaluate(`(() => {
    var b = document.querySelector('button[data-test="vote-button"], button[aria-label*="Upvote" i], button[aria-label*="Vote" i], button[data-test="action-bar-vote-button"]');
    if (!b) return null;
    return {
      pressed: b.getAttribute('aria-pressed'),
      label: b.getAttribute('aria-label') || b.getAttribute('area-label'),
      text: (b.textContent || '').replace(/\\s+/g, ' ').slice(0, 80),
      // Capture the count number from the text so we can compare even if button stays visually identical
      count: ((b.textContent || '').match(/\\d+/) || [null])[0],
    };
  })()`).catch(() => null);
}

async function vote(s) {
  const acct = await findProductHuntAccount();
  if (!acct) throw new Error('no_producthunt_account_in_db');
  const cookies = acct.metadata?.cookies ?? [];
  console.log(`[ph-vote] using account: ${acct.username} (${cookies.length} cookies)`);
  if (cookies.length < 1) throw new Error('producthunt_account_missing_cookies');

  await injectPHCookies(s, cookies);
  await s.goto(TARGET_URL);
  await sleep(4);

  // Dismiss cookie consent banner if present
  const t0 = await readPage(s);
  if (t0.includes('cookies') || t0.includes('cookie preferences')) {
    await s.click('Accept all').catch(() => {});
    await s.click('Accept cookies').catch(() => {});
    await sleep(2);
  }

  // The homepage feed exposes inline launch vote buttons (data-test="vote-button")
  // — those record a real vote. Product hub pages (/products/<slug>) only carry
  // action-bar-vote-button which navigates away. So unless the user explicitly
  // gave us a /posts/ launch URL, we vote on the homepage feed directly.
  const cur = s.page.url();
  if (cur.includes('/products/') && !TARGET_URL.includes('/products/')) {
    console.log('[ph-vote] redirected to product hub — going back to homepage');
    await s.goto('https://www.producthunt.com/');
    await sleep(3);
  }

  const beforeState = await readVoteState(s);
  console.log(`[ph-vote] before: ${JSON.stringify(beforeState)}`);

  let btn = await findVoteButton(s);
  if (!btn) throw new Error('vote_button_not_found');
  console.log(`[ph-vote] vote button found: ${btn.sel} label="${btn.label}" at (${Math.round(btn.x)},${Math.round(btn.y)})`);

  // Scroll button into view, then re-measure (post-scroll viewport coords differ)
  await s.page.evaluate(`(() => {
    var b = document.querySelector('button[data-test*="vote"], button[aria-label*="Upvote" i], button[aria-label*="Vote" i], button[data-sentry-component*="VoteButton" i]');
    if (b) b.scrollIntoView({ block: 'center', behavior: 'instant' });
  })()`).catch(() => {});
  await sleep(1);
  btn = await findVoteButton(s);
  if (!btn) throw new Error('vote_button_lost_after_scroll');
  console.log(`[ph-vote] post-scroll coords: (${Math.round(btn.x)},${Math.round(btn.y)})`);

  // mouse.click routes through CDP → SetTrusted(true) — required for PH's vote handler
  await s.page.mouse.click(btn.x, btn.y).catch(() => {});
  await sleep(3);

  const afterState = await readVoteState(s);
  console.log(`[ph-vote] after: ${JSON.stringify(afterState)}`);

  const flipped = beforeState && afterState &&
    (beforeState.pressed !== afterState.pressed ||
     beforeState.label !== afterState.label ||
     (beforeState.count || '') !== (afterState.count || '') ||
     (beforeState.text || '') !== (afterState.text || ''));
  if (!flipped) {
    const url = s.page.url();
    if (url.includes('/login') || url.includes('/sign-in')) throw new Error('redirected_to_login');
    throw new Error(`vote_state_unchanged: ${JSON.stringify(afterState)}`);
  }

  console.log(`[ph-vote] vote registered`);
  return acct.username;
}

const s = await WSession.start({ label: 'producthunt_upvote', proxy });
try {
  const username = await vote(s);
  console.log(`PASS: ${username} upvoted ${TARGET_URL}`);
  await s.close();
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  await s.close().catch(() => {});
  process.exit(1);
}
