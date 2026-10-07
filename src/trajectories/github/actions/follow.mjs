import {
  getSocialAccount,
  resolveAccountSession,
  markCookiesStale,
} from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectGitHubBanSignals } from '../../../../dist/platforms/github/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import {
  assertAuthed,
  AuthProbeError,
} from '../../_shared/auth/auth-probe.mjs';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import {
  pageSettled,
  responseAfterAction,
} from '../../_shared/page/settled.mjs';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');

const acct = await getSocialAccount('github');
if (!acct) {
  console.log('FAIL: no active github account');
  process.exit(1);
}
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({
  label: 'github_follow',
  proxy: proxyUrl,
  persona,
});

let ban = null;
try {
  const stored = (acct.metadata?.cookies ?? []).filter((c) =>
    /github\.com/.test(c.domain ?? ''),
  );
  if (stored.length)
    await s.ctx.addCookies(stored.map((c) => ({ ...c, path: c.path || '/' })));
  // If no target, scrape first user card from /explore. Deterministic: explore renders /users/<name> profile cards in articles.
  let target = TARGET_USER;
  if (!target) {
    await s.goto('https://github.com/explore');
    checkReachable(s, 'github');
    await pageSettled(s.page);
    target = await s.page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('a[href^="/"]')).find(
        (a) =>
          /^\/[\w-]+$/.test(a.getAttribute('href') || '') &&
          a.querySelector('img.avatar') &&
          a.getAttribute('href')?.length < 25,
      );
      return link ? link.getAttribute('href').replace(/^\//, '') : '';
    });
    if (!target) throw new Error('no target user found on /explore');
  }

  await s.goto(`https://github.com/${encodeURIComponent(target)}`);
  checkReachable(s, 'github');
  await pageSettled(s.page);
  try {
    await assertAuthed('github', s, { label: 'github_follow' });
  } catch (probeErr) {
    if (probeErr instanceof AuthProbeError) {
      try {
        await markCookiesStale(acct.id);
      } catch (markError) {
        throw new AggregateError(
          [probeErr, markError],
          'GitHub authentication and stale-cookie recording failed',
        );
      }
    }
    throw probeErr;
  }

  // GitHub follow form: <form action="/users/follow?target=<name>"> with
  // <button> Follow </button>. After click form swaps to action="/users/
  // unfollow?target=<name>". Action regex matches the path; the visible
  // form is the one we want.
  const followForm = s.page
    .locator(`form[action*="/users/follow"]`)
    .filter({ visible: true })
    .first();
  const unfollowForm = s.page
    .locator(`form[action*="/users/unfollow"]`)
    .filter({ visible: true })
    .first();
  const alreadyFollowing = await unfollowForm.count();
  if (alreadyFollowing > 0) {
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses);
    console.log(`PASS: already following ${target}`);
  } else {
    await followForm.waitFor({ state: 'visible' });
    const submit = followForm
      .locator(
        'button[type="submit"], button:not([type]), input[type="submit"]',
      )
      .filter({ visible: true })
      .first();
    await submit.waitFor({ state: 'visible' });
    const response = await responseAfterAction(
      s.page,
      (request) => {
        const url = new URL(request.url());
        return (
          request.method() === 'POST' &&
          url.origin === 'https://github.com' &&
          url.pathname === '/users/follow' &&
          url.searchParams.get('target')?.toLowerCase() === target.toLowerCase()
        );
      },
      () => humanClickLocator(s.page, submit),
    );
    const responseError = await response.finished();
    if (responseError)
      throw new Error('GITHUB_FOLLOW_RESPONSE_FAILED', {
        cause: responseError,
      });
    if (!response.ok())
      throw new Error(
        `GITHUB_FOLLOW_REFUSED: HTTP ${response.status()} at ${response.url()}`,
      );
    await unfollowForm.waitFor({ state: 'visible' });
    ban = await detectGitHubBanSignals(s.page, s.capturedResponses);
    console.log(`PASS: followed ${target}`);
  }
  console.log(`[ban-signal] ${ban?.signal}`);
} catch (e) {
  console.error('GITHUB_FOLLOW_FAILED:', e);
  ban = e?.banSignal ?? null;
  if (!ban) {
    try {
      ban = await detectGitHubBanSignals(s.page, s.capturedResponses);
    } catch (error) {
      console.error('GITHUB_BAN_OBSERVATION_FAILED:', error);
    }
  }
  process.exitCode = 1;
} finally {
  if (ban) {
    try {
      const dir = runRecordingsDir('github_follow');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'ban_signal.json'),
        JSON.stringify(
          {
            account_id: acct.id,
            username: acct.username,
            action: 'github_follow',
            target_user: TARGET_USER,
            ...ban,
            ts: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error('GITHUB_BAN_RECORD_FAILED:', error);
      process.exitCode = 1;
    }
  }
  await s.close();
}
