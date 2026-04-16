import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.tiktok.com/signup';
const GOAL = `generate_identity(platform="tiktok"). Click "Use phone or email". Click "Sign up with email". For birthday use select_option(target="month",value=$TIKTOK_NEW_BIRTHMONTH), select_option(target="day",value=$TIKTOK_NEW_BIRTHDAY), select_option(target="year",value=$TIKTOK_NEW_BIRTHYEAR). Fill email with $TIKTOK_NEW_EMAIL. Fill password with $TIKTOK_NEW_PASSWORD. Click "Send code". check_email(email=$TIKTOK_NEW_EMAIL,sender="tiktok") for code. Fill code. Click Next. done(value=$TIKTOK_NEW_USERNAME).`;

if (process.env.TIKTOK_HARDCODED !== '1') {
  // Default: LLM-agent path
  const s = await WSession.start({ label: 'tiktok_register', proxy: process.env.PROXY_URL || 'residential' });
  try {
    await s.goto(URL);
    const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'tiktok_register' });
    console.log('PASS:', result.value);
  } catch (e) {
    console.log('FAIL:', e.message?.slice(0, 200));
    process.exit(1);
  } finally {
    await s.close();
  }
} else {
  // Hardcoded trajectory — bypasses LLM agent
  // Retry the flow up to 3 times if browser/page dies during early setup (crash-prone with custom Chromium)
  let id = null, password = null, s = null, success = false;

  for (let retry = 0; retry < 3; retry++) {
    if (s) { await s.close().catch(() => {}); s = null; }

    s = await WSession.start({ label: 'tiktok_register', proxy: process.env.PROXY_URL || 'residential' });
    try {
      // Fresh identity per retry — don't reuse emails across failed runs
      id = await s.generateIdentity('tiktok');
      // Use a simple password pattern TikTok accepts: letters + numbers + special chars, ~14 chars
      const rnd = Math.floor(Math.random() * 100000);
      password = `Wisent${rnd}!Xy`;
      console.log(`[test] attempt ${retry + 1}: identity=${id.username} <${id.email}> bday=${id.birthMonth}/${id.birthDay}/${id.birthYear}`);

      await s.goto(URL);
      await s.wait(3);

      // Verify page is alive
      const alive = await s.page.evaluate('document.querySelector("body") !== null').catch(() => false);
      if (!alive) { console.log(`[test] attempt ${retry + 1}: page died after goto`); continue; }

      // Dismiss cookie banner if EU/UK proxy
      for (const sel of ['button:has-text("Decline optional cookies")', 'button:has-text("Accept all")', 'button:has-text("Allow all")']) {
        try {
          const btn = s.page.locator(sel).first();
          if (await btn.isVisible().catch(() => false)) { await btn.click(); console.log(`[test] Dismissed cookie banner`); break; }
        } catch {}
      }

      // Click "Use phone or email"
      const r1 = await s.click('Use phone or email');
      if (r1 === 'no-target-found') { console.log(`[test] attempt ${retry + 1}: channel selection failed`); continue; }
      await s.wait(2);

      // Click "Sign up with email" (switch from /phone to /email tab)
      const urlAfterChannel = s.page.url?.() ?? '';
      if (!urlAfterChannel.includes('/email')) {
        await s.click('Sign up with email');
        await s.wait(2);
      }

      // Select birthday
      await s.select('month', id.birthMonth);
      await s.select('day', id.birthDay);
      await s.select('year', id.birthYear);
      await s.wait(1);

      // Fill email and password (literal values — avoid env substitution)
      await s.fill('Email', id.email);
      await s.fill('Password', password);
      await s.wait(2);

      // Click "Send code" using humanClick (same as the successful LLM-agent path)
      await s.click('Send code');
      console.log('[test] Clicked Send code');
      await s.wait(3);

      // Probe for captcha
      const probe = await s.page.evaluate(`(() => {
        const t = document.body.innerText || '';
        const indicators = [];
        if (document.querySelector('.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]')) indicators.push('captcha-container');
        if (document.querySelector('iframe[src*="captcha"]')) indicators.push('captcha-iframe');
        if (/drag|puzzle|rotate|slide/i.test(t)) indicators.push('captcha-text');
        if (/too many|attempts|try again later/i.test(t)) indicators.push('rate-limit');
        const hasResend = /Resend code/i.test(t);
        return { indicators, hasResend, url: location.href };
      })()`).catch(() => ({ error: true }));
      console.log(`[test] After Send code: ${JSON.stringify(probe)}`);
      await s.screenshot(`after_send_code_r${retry}`).catch(() => {});

      if (!probe.hasResend) {
        console.log(`[test] attempt ${retry + 1}: Send code did not advance form (no Resend countdown). indicators=${probe.indicators?.join(',') || 'none'}`);
        // If it's rate-limit, don't retry
        if (probe.indicators?.includes('rate-limit')) { console.log('FAIL: TikTok rate-limited this session'); break; }
        // If captcha, log and give up for this attempt (will handle separately)
        if (probe.indicators?.length) { console.log(`FAIL: captcha detected — ${probe.indicators.join(',')}`); break; }
        continue;
      }

      // Poll Resend for verification code
      console.log(`[test] Polling email for ${id.email}...`);
      const code = await s.checkEmail(id.email, 'tiktok');
      if (!code || code === 'no code received' || !/^\d{4,8}$/.test(code)) {
        console.log(`[test] attempt ${retry + 1}: no code (${code})`);
        continue;
      }
      console.log(`[test] Got code: ${code}`);

      // Fill code and click Next
      await s.fill('code', code);
      await s.wait(1);
      await s.click('Next');
      await s.wait(5);

      const finalUrl = s.page.url?.() ?? '';
      const pageText = await s.page.evaluate('document.body.innerText').catch(() => '');
      const errorSnippet = (pageText || '').split('\n').filter(l => /error|invalid|incorrect|attempt|try again|captcha/i.test(l)).slice(0, 3).join(' | ');
      console.log(`[test] After Next: url=${finalUrl}${errorSnippet ? ' | errors=' + errorSnippet : ''}`);
      await s.screenshot(`after_next_r${retry}`).catch(() => {});

      // If "Max attempts" error, retry is unlikely to help (TikTok flagged session)
      if (/attempts reached|try again later/i.test(errorSnippet)) {
        console.log('[test] TikTok blocked with Max attempts — session flagged');
        continue;
      }

      // Username page (sometimes shown)
      if (/\/username|create a username|set a username/i.test(finalUrl + ' ' + pageText)) {
        await s.fill('Username', id.username);
        await s.wait(1);
        await s.click('Next');
        await s.wait(3);
      }

      // Save account (anywhere that isn't an explicit error is considered success)
      if (!errorSnippet) {
        await s.saveAccount('tiktok', { username: id.username, email: id.email, password });
        console.log(`PASS: ${id.username}`);
        success = true;
        break;
      }
    } catch (e) {
      console.log(`[test] attempt ${retry + 1} crashed: ${e.message?.slice(0, 120)}`);
    }
  }

  if (s) await s.close().catch(() => {});
  if (!success) { console.log('FAIL: exhausted retries'); process.exit(1); }
}
