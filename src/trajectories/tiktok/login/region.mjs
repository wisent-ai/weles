// TikTok's login page probes /passport/web/region/ cross-origin before it
// enables the form. Through residential proxies that probe is flaky (ERR_FAILED
// on the CORS preflight), and one failed probe breaks the whole form. Both
// halves below short-circuit it: the cookies tell the page it is already in the
// US/EN locale, and the route answers the probe the way the page expects.

const REGION_COOKIES = [
  { name: 'tt-target-idc', value: 'useast5' },
  { name: 'tt_chain_token', value: '' },
  { name: 'cmpl_token', value: '' },
  { name: 'store-idc', value: 'useast5' },
  { name: 'store-country-code', value: 'us' },
  { name: 'store-country-code-src', value: 'uid' },
];

/** Pre-seed the region cookies so the page skips the region detector. */
export async function seedRegionCookies(ctx) {
  const cookies = REGION_COOKIES.map((cookie) => ({
    ...cookie, domain: '.tiktok.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax',
  }));
  await ctx.addCookies(cookies).catch((e) => console.log(`[trajectory] region cookie seed failed: ${e.message}`));
}

/**
 * Answer the region probe locally. The page's getMaxNumberDomain() reads
 * {data.domain, data.ttwid_migration_ticket} from each response and picks the
 * majority domain; returning www.tiktok.com keeps every later passport call
 * same-origin, so no CORS preflight is needed.
 */
export async function mockRegionEndpoint(page) {
  await page.route(/\/passport\/web\/region\//, async (route) => {
    const req = route.request();
    console.log(`[tiktok_login] mocking region: ${req.url().slice(0, 100)}`);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': 'https://www.tiktok.com',
        'Access-Control-Allow-Credentials': 'true',
      },
      body: JSON.stringify({
        message: 'success',
        data: {
          domain: 'www.tiktok.com',
          ttwid_migration_ticket: '',
          error_code: 0,
        },
      }),
    });
  });
}
