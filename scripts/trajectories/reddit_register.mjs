import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.reddit.com/register';
const GOAL = `generate_identity(platform="reddit"). Fill email with $REDDIT_NEW_EMAIL. Click Continue. If captcha, solve_captcha(sitekey="6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ"). check_email(email=$REDDIT_NEW_EMAIL,sender="reddit") for code. Fill code. Set username $REDDIT_NEW_USERNAME and password $REDDIT_NEW_PASSWORD. After registration if onboarding questions appear, dismiss them. save_account(platform="reddit",username=$REDDIT_NEW_USERNAME,email=$REDDIT_NEW_EMAIL,password=$REDDIT_NEW_PASSWORD). done(value=$REDDIT_NEW_USERNAME).`;

const s = await WSession.start({ label: 'reddit_register', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'reddit_register' });
  // Verify the trajectory actually persisted the account before claiming PASS.
  // The agent's done(value=username) reflects its belief, not the DB. Look up
  // the username and confirm a row exists with cookies to prove auth-completion.
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const username = result.value;
  if (supabaseUrl && key && username) {
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?platform=eq.reddit&username=eq.${encodeURIComponent(username)}&select=id,metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json();
    if (!rows?.[0]) { console.log(`FAIL: agent reported done(${username}) but no DB row — save_account did not run`); process.exit(1); }
    const cookies = rows[0].metadata?.cookies ?? [];
    const hasSession = cookies.some?.((c) => /reddit_session|token_v2/.test(c?.name ?? ''));
    if (!hasSession) console.log(`WARN: row ${rows[0].id} saved but no reddit_session cookie — auth may be incomplete`);
    console.log(`PASS: ${username} (db_row=${rows[0].id} cookies=${cookies.length})`);
  } else {
    console.log('PASS:', username);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
