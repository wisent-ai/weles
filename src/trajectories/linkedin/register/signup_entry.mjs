/**
 * How the run reaches a signup form it can actually type into: the optional
 * guest warm-up, then the one declared entry path. There is no second route —
 * an entry path that does not reach the form ends the run with a refusal that
 * says where it stopped.
 *
 * The signup affordance is found by where it leads, not by what it says: a
 * visible link whose target is the signup route LinkedIn serves (the path of
 * SIGNUP_URL), so the entry works in any locale and wording.
 */
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { SIGNUP_URL } from './run_request.mjs';
import { writeSubmitDiagnostics } from './diagnostics.mjs';

const SIGNUP_PATH = new URL(SIGNUP_URL).pathname;
const LINKEDIN_HOST = /(^|\.)linkedin\.com$/i;

/** Whether `url` is LinkedIn's signup route or a page beneath it. */
function isSignupRoute(url) {
  return (
    LINKEDIN_HOST.test(url.hostname) &&
    (url.pathname === SIGNUP_PATH || url.pathname.startsWith(`${SIGNUP_PATH}/`))
  );
}

export async function prewarmLinkedinGuestSession(session, urls) {
  if (!urls.length) return null;
  const diagnostics = { urls, transitions: [] };
  for (const url of urls) {
    await session.runStep(
      `prewarm_${diagnostics.transitions.length}`,
      async () => {
        await session.page.goto(url, { waitUntil: 'domcontentloaded' });
        return `prewarm ${session.page.url()}`;
      },
    );
    // One viewport of scrolling gives the guest session a behavioural
    // signal; the distance is the page's own measured height.
    const viewport = await session.page.evaluate(() => window.innerHeight);
    await session.scroll('down', viewport);
    await pageSettled(session.page);
    diagnostics.transitions.push(
      await session.page.evaluate(() => ({
        url: location.href,
        title: document.title,
        referrer: document.referrer,
        cookie_count: document.cookie.split(';').filter(Boolean).length,
        page_key: document
          .querySelector('meta[name="pageKey"]')
          ?.getAttribute('content'),
        authwall: /\/authwall/.test(location.href),
        visible_text_sample: document.body.innerText
          .replace(/\s+/g, ' ')
          .trim(),
      })),
    );
  }
  await writeSubmitDiagnostics('guest_prewarm_diagnostics', diagnostics);
  return diagnostics;
}

/** The page's state at `stage`, with every link on it that leads to signup. */
async function pageState(page, stage) {
  const state = await page.evaluate(
    (s) => ({
      stage: s,
      url: location.href,
      title: document.title,
      referrer: document.referrer,
      links: Array.from(document.querySelectorAll('a[href]'), (a) => ({
        text: a.textContent.replace(/\s+/g, ' ').trim(),
        href: a.href,
        tracking_control: a.getAttribute('data-tracking-control-name'),
        visible: a.checkVisibility(),
      })),
    }),
    stage,
  );
  const { links, ...rest } = state;
  return {
    ...rest,
    signup_links: links
      .filter((link) => isSignupRoute(new URL(link.href)))
      .map((link) => ({
        ...link,
        trk_param: new URL(link.href).searchParams.get('trk'),
      })),
  };
}

/**
 * The first visible link on the page whose target is the signup route, as a
 * locator the human click can drive; null when the page shows none.
 */
async function signupAffordance(page) {
  const links = page.locator('a[href]').filter({ visible: true });
  for (const link of await links.all()) {
    const href = await link.evaluate((a) => a.href);
    if (isSignupRoute(new URL(href))) return link;
  }
  return null;
}

export async function enterLinkedinSignup(session, entryUrl) {
  if (typeof entryUrl !== 'string' || !entryUrl) {
    throw new Error(
      'bad_entry_path: no entry URL was given; LINKEDIN_REGISTER_ENTRY_URL or the declared signup URL names it',
    );
  }
  if (/trk=cold_join_sign_in/i.test(entryUrl)) {
    throw new Error('bad_entry_path: refusing trk=cold_join_sign_in');
  }
  let entryHost;
  try {
    entryHost = new URL(entryUrl).hostname;
  } catch (e) {
    throw new Error(`bad_entry_path: ${entryUrl} is not a URL: ${e.message}`, {
      cause: e,
    });
  }
  if (!LINKEDIN_HOST.test(entryHost)) {
    throw new Error(`bad_entry_path: non-linkedin host: ${entryHost}`);
  }
  const direct = entryUrl.replace(/\/$/, '') === SIGNUP_URL;
  const diagnostics = {
    mode: direct ? 'direct_signup' : 'entry_chain',
    entry_url: entryUrl,
    signup_url: SIGNUP_URL,
    transitions: [],
  };
  const record = async (stage) => {
    diagnostics.transitions.push(await pageState(session.page, stage));
  };

  if (direct) {
    await session.runStep('goto_signup', async () => {
      await session.page.goto(SIGNUP_URL, { waitUntil: 'domcontentloaded' });
      return `signup ${session.page.url()}`;
    });
    await record('after_direct_signup');
    await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
    return diagnostics;
  }

  await session.runStep('goto_entry', async () => {
    await session.page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
    return `entry ${session.page.url()}`;
  });
  await pageSettled(session.page);
  await record('after_entry');

  const affordance = await signupAffordance(session.page);
  if (!affordance) {
    diagnostics.clicked_signup_link = false;
    await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
    throw new Error(
      `entry_path_no_signup_click: the declared entry path shows no visible link to ${SIGNUP_PATH}, so the run never reached the signup form; it stopped at ${session.page.url()}`,
    );
  }
  diagnostics.clicked_signup_affordance = await affordance.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    href: el.href,
    tracking_control: el.getAttribute('data-tracking-control-name'),
  }));
  await humanClickLocator(session.page, affordance);
  diagnostics.clicked_signup_link = true;
  try {
    await session.page.waitForURL(isSignupRoute);
  } catch (transitionError) {
    diagnostics.signup_transition_error = transitionError.message;
    await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
    throw new Error(
      `entry_path_no_signup_transition: the entry affordance was clicked but the browser never arrived at the signup form; it stopped at ${session.page.url()}`,
      { cause: transitionError },
    );
  }
  await pageSettled(session.page);
  await record('after_signup_transition');
  await writeSubmitDiagnostics('entry_path_diagnostics', diagnostics);
  return diagnostics;
}
