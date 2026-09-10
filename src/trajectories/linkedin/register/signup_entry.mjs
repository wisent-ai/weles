/**
 * How the run reaches a signup form it can actually type into: the optional
 * guest warm-up, then the one declared entry path. There is no second route —
 * an entry path that does not reach the form ends the run with a refusal that
 * says where it stopped.
 */
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { DEFAULT_ENTRY_URL, SIGNUP_URL } from './run_request.mjs';
import { writeSubmitDiagnostics } from './diagnostics.mjs';

export async function prewarmLinkedinGuestSession(session, urls) {
  if (!urls.length) return null;
  const diagnostics = {
    urls,
    transitions: [],
  };
  for (const url of urls) {
    try {
      await session.runStep(`prewarm_${diagnostics.transitions.length}`, async () => {
        await session.page.goto(url, { waitUntil: 'domcontentloaded' });
        return `prewarm ${session.page.url()}`;
      });
      // Fast scroll to generate behavioral signal without spending human-like time
      // on a cold guest session. The goal is cookie/telemetry warm-up, not realism.
      await session.scroll('down', 400);
      await humanIdlePause('deliberate');
    } catch (prewarmErr) {
      console.log(`[register] prewarm skip ${url}: ${prewarmErr.message?.slice(0, 120)}`);
      diagnostics.transitions.push({ url, stage: 'prewarm_error', error: String(prewarmErr?.message ?? prewarmErr).slice(0, 200) });
      continue;
    }
    diagnostics.transitions.push(await session.page.evaluate(() => {
      const attr = (el, name) => {
        const raw = el?.getAttribute(name);
        return typeof raw === 'string' ? raw : null;
      };
      return {
        url: location.href,
        title: document.title,
        referrer: document.referrer,
        cookie_count: document.cookie ? document.cookie.split(';').filter(Boolean).length : 0,
        page_key: attr(document.querySelector('meta[name="pageKey"]'), 'content'),
        authwall: /\/authwall/.test(location.href),
        visible_text_sample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    }).catch((e) => ({ url: session.page.url(), error: String(e?.message ?? e).slice(0, 200) })));
  }
  await writeSubmitDiagnostics('guest_prewarm_diagnostics', diagnostics);
  return diagnostics;
}

export async function enterLinkedinSignup(session, entryUrl) {
  const entry = String(entryUrl || DEFAULT_ENTRY_URL);
  if (/trk=cold_join_sign_in/i.test(entry)) {
    throw new Error('bad_entry_path: refusing trk=cold_join_sign_in');
  }
  try {
    const u = new URL(entry);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) throw new Error(`non-linkedin host: ${u.hostname}`);
  } catch (e) {
    throw new Error(`bad_entry_path: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  const direct = entry.replace(/\/$/, '') === SIGNUP_URL;
  const diagnostics = {
    mode: direct ? 'direct_signup' : 'entry_chain',
    entry_url: entry,
    signup_url: SIGNUP_URL,
    transitions: [],
  };
  const record = async (stage) => {
    diagnostics.transitions.push(await session.page.evaluate((s) => {
      const attr = (el, name) => {
        const raw = el?.getAttribute(name);
        return typeof raw === 'string' ? raw : null;
      };
      return {
        stage: s,
        url: location.href,
        title: document.title,
        referrer: document.referrer,
        signup_links: Array.from(document.querySelectorAll('a[href*="/signup"], a[href*="/join"]')).slice(0, 20).map((a) => ({
          text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          href: a.href,
          trk: attr(a, 'data-tracking-control-name') ?? new URL(a.href, location.href).searchParams.get('trk'),
          visible: !!(a.offsetWidth || a.offsetHeight || a.getClientRects().length),
        })),
        signup_affordances: Array.from(document.querySelectorAll('a, button')).map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          href: el instanceof HTMLAnchorElement ? el.href : '',
          trk: attr(el, 'data-tracking-control-name'),
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        })).filter((el) => /^(sign up|join now)$/i.test(el.text)).slice(0, 20),
      };
    }, stage).catch((e) => ({ stage, error: String(e?.message ?? e).slice(0, 200), url: session.page.url() })));
  };

  if (direct) {
    try {
      await session.runStep('goto_signup', async () => {
        await session.page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded' });
        return `signup ${session.page.url()}`;
      });
    } catch (e) {
      const formVisible = await session.page
        .locator('input[name="email-address"], input#email-address, input[type="email"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (!formVisible) throw e;
      diagnostics.direct_signup_goto_timeout_form_visible = true;
      diagnostics.direct_signup_goto_timeout_error = String(e?.message ?? e).slice(0, 300);
      console.log('[register] signup goto timed out, but signup form is visible — continuing');
    }
    await record('after_direct_signup');
    await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
    return diagnostics;
  }

  await session.runStep('goto_entry', async () => {
    await session.page.goto(entry, { waitUntil: 'domcontentloaded' });
    return `entry ${session.page.url()}`;
  });
  await humanIdlePause('deliberate');
  await record('after_entry');

  const explicitSelector = process.env.LINKEDIN_REGISTER_ENTRY_CLICK_SELECTOR || '';
  const clickCandidates = explicitSelector
    ? [session.page.locator(explicitSelector).filter({ visible: true }).first()]
    : [
        session.page.getByRole('link', { name: /^Join now$/i }).first(),
        session.page.getByRole('button', { name: /^Join now$/i }).first(),
        session.page.getByRole('link', { name: /^Sign up$/i }).first(),
        session.page.getByRole('button', { name: /^Sign up$/i }).first(),
      ];
  let clicked = false;
  let clickError = '';
  let clickedAffordance = null;
  for (const loc of clickCandidates) {
    try {
      if (await loc.count() && await loc.isVisible()) {
        clickedAffordance = await loc.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          href: el instanceof HTMLAnchorElement ? el.href : '',
          trk: el.getAttribute('data-tracking-control-name'),
        }));
        await humanClickLocator(session.page, loc);
        clicked = true;
        break;
      }
    } catch (e) {
      clickError = String(e?.message ?? e).slice(0, 200);
    }
  }
  diagnostics.clicked_signup_link = clicked;
  diagnostics.clicked_signup_affordance = clickedAffordance;
  diagnostics.click_error = clickError;
  if (!clicked) {
    await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
    throw new Error(`entry_path_no_signup_click: the declared entry path offered no clickable "Sign up" or "Join now" affordance, so the run never reached the signup form; it stopped at ${session.page.url().slice(0, 180)}`);
  }
  try {
    await session.page.waitForURL(/\/signup(?:$|[/?#])/);
  } catch (transitionError) {
    diagnostics.signup_transition_error = String(transitionError?.message ?? transitionError).slice(0, 200);
    await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
    throw new Error(`entry_path_no_signup_transition: the entry affordance was clicked but the browser never arrived at the signup form; it stopped at ${session.page.url().slice(0, 180)}`);
  }
  await humanIdlePause('deliberate');
  await record('after_signup_transition');
  await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
  return diagnostics;
}
