// Write the linked character's persona content (name + bio) onto the
// GitHub profile via /settings/profile.
//
// Companion to instagram/tiktok/linkedin/twitter edit_profile.
// Lives under github/content/ because github/actions/ is at the 5-file cap.

import {
  getSocialAccount,
  resolveAccountSession,
  markCookiesStale,
} from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import {
  assertAuthed,
  AuthProbeError,
} from '../../_shared/auth/auth-probe.mjs';
import {
  loadFreshCookieJarOrFail,
  CookieJarStaleError,
} from '../../_shared/auth/cookie-freshness.mjs';
import { loadAvatarFile } from '../../_shared/runner/avatar-loader.mjs';
import { updateAccountMetadata } from '../../_shared/skarbiec/accounts.mjs';
import {
  pageSettled,
  responseAfterAction,
} from '../../_shared/page/settled.mjs';
import { fitsField } from '../../_shared/page/fits.mjs';

const PROFILE_URL = 'https://github.com/settings/profile';

function postAt(request, origin, pathname) {
  if (request.method() !== 'POST') return false;
  const url = new URL(request.url());
  return url.origin === origin && pathname.test(url.pathname);
}

async function acknowledged(response, operation) {
  const details = {
    operation,
    requestMethod: response.request().method(),
    requestUrl: response.url(),
    status: response.status(),
  };
  if (details.status < 200 || details.status >= 400) {
    throw Object.assign(
      new Error(`GitHub ${operation} returned HTTP ${details.status}`),
      {
        code: 'GH_PROFILE_HTTP_ERROR',
        ...details,
      },
    );
  }
  let failed;
  try {
    failed = await response.finished();
  } catch (error) {
    failed = error;
  }
  if (failed) {
    throw Object.assign(
      new Error(`GitHub ${operation} response did not complete`, {
        cause: failed,
      }),
      {
        code: 'GH_PROFILE_RESPONSE_FAILED',
        ...details,
      },
    );
  }
  console.log(`[gh-profile] ${operation} acknowledged: HTTP ${details.status}`);
}

async function openProfile(session) {
  const response = await session.page.goto(PROFILE_URL, { waitUntil: 'load' });
  if (!response?.ok()) {
    throw Object.assign(
      new Error('GitHub profile page could not be loaded successfully'),
      {
        code: 'GH_PROFILE_READ_HTTP_ERROR',
        status: response?.status() ?? null,
        requestUrl: PROFILE_URL,
        pageUrl: session.page.url(),
      },
    );
  }
  await pageSettled(session.page);
  if (/\/login/.test(new URL(session.page.url()).pathname)) {
    throw new CookieJarStaleError(
      `GitHub profile redirected to login: ${session.page.url()}`,
      { platform: 'github' },
    );
  }
  await assertAuthed('github', session, { label: 'github_edit_profile' });
}

const acct = await getSocialAccount('github');
if (!acct) {
  console.log('FAIL: no active github account in Skarbiec');
  process.exit(1);
}
console.log(`[gh-profile] using account: ${acct.username}`);
const character = acct.metadata?.character;
if (!character || typeof character !== 'object') {
  console.log(`FAIL: no character stored for github/${acct.username}`);
  process.exit(1);
}
console.log(
  `[gh-profile] character: ${character.name} (niche=${character.niche})`,
);

const targetName = character.name || '';
// The bio goes up whole; each field's own maxlength decides whether it fits.
const targetBio = character.bio;
const targetLocation = [character.home_city, character.home_country]
  .filter(Boolean)
  .join(', ');
// Avatar metadata must already contain a private Weles Stado object locator.
const avatarUrl =
  character.avatar_url ||
  (Array.isArray(character.training_images)
    ? character.training_images[0]
    : null);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({
  label: 'github_edit_profile',
  proxy: proxyUrl,
  persona,
});

try {
  const all = loadFreshCookieJarOrFail(acct, {
    platform: 'github',
    label: 'github_edit_profile',
    currentProxyUrl: proxyUrl,
    currentPersona: persona,
  });
  const stored = all.filter((c) => /github\.com/.test(c.domain ?? ''));
  if (!stored.length)
    throw new CookieJarStaleError(
      'cookie_jar_no_domain_match: jar fresh but no github.com cookies',
      { platform: 'github' },
    );
  await s.ctx.addCookies(stored.map((c) => ({ ...c, path: c.path || '/' })));
  await openProfile(s);

  const nameIn = s.page
    .locator('input#user_display_name, input[name="user\\[display_name\\]"]')
    .filter({ visible: true })
    .first();
  const bioIn = s.page
    .locator('textarea#user_profile_bio, textarea[name="user[profile_bio]"]')
    .filter({ visible: true })
    .first();
  const locIn = s.page
    .locator(
      'input#user_profile_location, input[name="user[profile_location]"]',
    )
    .filter({ visible: true })
    .first();
  const fields = [
    [nameIn, targetName, 'name'],
    [bioIn, targetBio, 'bio'],
    [locIn, targetLocation, 'location'],
  ];
  const writes = [];

  // Avatar commits can replace the document. Finish them before typing text.
  if (avatarUrl) {
    const avatarFile = await loadAvatarFile(avatarUrl);
    const editSummary = s.page
      .locator(
        'form[aria-label="Profile picture"] summary, details summary:has-text("Edit")',
      )
      .filter({ visible: true })
      .first();
    if (await editSummary.isVisible())
      await humanClickLocator(s.page, editSummary);
    const fileIn = s.page.locator('input#avatar_upload').first();
    await fileIn.waitFor({ state: 'attached' });
    // The observed alambic flow obtains a policy, uploads, then offers cropping.
    const uploaded = await responseAfterAction(
      s.page,
      (request) =>
        postAt(request, 'https://uploads.github.com', /^\/avatars\/?$/),
      async () => {
        const policy = await responseAfterAction(
          s.page,
          (request) =>
            postAt(
              request,
              'https://github.com',
              /^\/upload\/policies\/avatars\/?$/,
            ),
          () => fileIn.setInputFiles(avatarFile),
        );
        await acknowledged(policy, 'avatar upload policy');
      },
    );
    await acknowledged(uploaded, 'avatar upload');
    const setBtn = s.page
      .locator('button:has-text("Set new profile picture")')
      .first();
    await setBtn.waitFor({ state: 'visible' });
    if (!(await setBtn.isEnabled())) {
      throw Object.assign(
        new Error('GitHub avatar commit button is disabled'),
        { code: 'GH_PROFILE_AVATAR_COMMIT_DISABLED' },
      );
    }
    const committed = await responseAfterAction(
      s.page,
      (request) =>
        postAt(request, 'https://github.com', /^\/settings\/avatars\/\d+\/?$/),
      () => humanClickLocator(s.page, setBtn),
    );
    await acknowledged(committed, 'avatar commit');
    writes.push('avatar commit acknowledged');
    await openProfile(s);
  }

  let textChanged = false;
  for (const [field, target, label] of fields) {
    if (!target) continue;
    if (!(await field.isVisible())) {
      throw Object.assign(
        new Error(`GitHub profile ${label} field is not visible`),
        { code: 'GH_PROFILE_FIELD_UNAVAILABLE', field: label },
      );
    }
    const current = await field.inputValue();
    if (current.trim() === target.trim()) continue;
    if (!(await field.isEditable())) {
      throw Object.assign(
        new Error(`GitHub profile ${label} field is not editable`),
        { code: 'GH_PROFILE_FIELD_LOCKED', field: label },
      );
    }
    await fitsField(field, target, `the GitHub profile ${label}`);
    await humanFill(s.page, field, target);
    await s.page.keyboard.press('Tab');
    const entered = await field.inputValue();
    if (entered.trim() !== target.trim()) {
      throw Object.assign(
        new Error(
          `GitHub profile ${label} input does not match the requested value`,
        ),
        {
          code: 'GH_PROFILE_INPUT_MISMATCH',
          field: label,
          expectedLength: target.length,
          observedLength: entered.length,
        },
      );
    }
    textChanged = true;
    writes.push(`${label} changed`);
  }

  if (textChanged) {
    const saveBtn = s.page
      .locator(
        'button[type="submit"]:has-text("Update profile"), input[value="Update profile"]',
      )
      .filter({ visible: true })
      .first();
    if (!(await saveBtn.isVisible()) || !(await saveBtn.isEnabled())) {
      throw Object.assign(
        new Error('GitHub Update profile control is not visible and enabled'),
        { code: 'GH_PROFILE_SAVE_NOT_ENABLED' },
      );
    }
    const submission = await saveBtn.evaluate((button) => {
      const form = button.form;
      if (!form) return null;
      return {
        method: (button.hasAttribute('formmethod')
          ? button.formMethod
          : form.method
        ).toUpperCase(),
        url: button.hasAttribute('formaction')
          ? button.formAction
          : form.action,
      };
    });
    if (
      !submission ||
      submission.method !== 'POST' ||
      new URL(submission.url).origin !== 'https://github.com'
    ) {
      throw Object.assign(
        new Error(
          'GitHub Update profile does not declare a supported native POST form',
        ),
        {
          code: 'GH_PROFILE_FORM_UNSUPPORTED',
          submission,
        },
      );
    }
    const destination = new URL(submission.url);
    destination.hash = '';
    const saved = await responseAfterAction(
      s.page,
      (request) =>
        request.method() === submission.method &&
        request.url() === destination.href,
      () => humanClickLocator(s.page, saveBtn),
    );
    await acknowledged(saved, 'profile save');
    // Read a fresh server response, not the locally edited input values.
    await openProfile(s);
  }

  for (const [field, target, label] of fields) {
    if (!target) continue;
    if (!(await field.isVisible())) {
      throw Object.assign(
        new Error(`GitHub profile ${label} readback field is not visible`),
        { code: 'GH_PROFILE_FIELD_UNAVAILABLE', field: label },
      );
    }
    const observed = await field.inputValue();
    if (observed.trim() !== target.trim()) {
      throw Object.assign(
        new Error(
          `GitHub profile ${label} readback differs from the requested value`,
        ),
        {
          code: 'GH_PROFILE_READBACK_MISMATCH',
          field: label,
          expectedLength: target.length,
          observedLength: observed.length,
        },
      );
    }
  }
  if (!(await nameIn.isVisible())) {
    throw Object.assign(
      new Error('GitHub profile name cannot be read for Skarbiec'),
      { code: 'GH_PROFILE_FIELD_UNAVAILABLE', field: 'name' },
    );
  }
  const observedName = await nameIn.inputValue();
  updateAccountMetadata(acct.id, {
    display_name: observedName || null,
    profile_url: `https://github.com/${acct.username}`,
    updated_at: new Date().toISOString(),
  });
  if (!writes.length)
    console.log(
      'PASS: no-op (form values already match character; Skarbiec synced)',
    );
  else
    console.log(
      `PASS: ${acct.username} profile fields verified; ${writes.join('; ')}`,
    );
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
  if (error instanceof CookieJarStaleError || error instanceof AuthProbeError) {
    try {
      await markCookiesStale(acct.id);
    } catch (metadataError) {
      console.error(
        '[gh-profile] could not mark the cookie jar stale:',
        metadataError,
      );
    }
  }
} finally {
  await s.close();
}
