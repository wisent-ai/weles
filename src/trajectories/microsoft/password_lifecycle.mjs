import { randomInt } from 'node:crypto';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { updateAccount } from '../../../dist/state/skarbiec-records.js';
import {
  readWelesManagedCredential,
  writeWelesAcquiredSecret,
} from '../../../dist/secrets/scoped-service.js';
import { WSession } from '../../../dist/session/wsession.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';

const MICROSOFT_PASSWORD_ID = /^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/;
const PASSWORD_FIELD = 'password';
const PASSWORD_CHANGE_URL = 'https://account.live.com/password/Change';
const LOGIN_URL = 'https://login.live.com/login.srf';
const IDENTITY_CHALLENGE = /verify your identity|get a code|approve sign in|enter.{0,20}code|passkey|security key/i;

function constraints(expectedOperation) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.WELES_CREDENTIAL_CONSTRAINTS ?? '{}');
  } catch {
    throw new Error('invalid Weles credential constraints');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid Weles credential constraints');
  }
  const credentialId = typeof parsed.secret === 'string' ? parsed.secret : '';
  const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : '';
  const operation = typeof parsed.operation === 'string' ? parsed.operation : '';
  const accountEmail = typeof parsed.account_email === 'string' ? parsed.account_email.trim().toLowerCase() : '';
  const tenantId = typeof parsed.tenant_id === 'string' ? parsed.tenant_id : null;
  if (!MICROSOFT_PASSWORD_ID.test(credentialId)
      || operation !== expectedOperation
      || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)
      || parsed.vault_item_id !== credentialId
      || parsed.vault_field !== PASSWORD_FIELD
      || !/^[a-f0-9]{64}$/i.test(requestId)
      || parsed.provider !== 'microsoft') {
    throw new Error('Microsoft password operation is outside its exact Skarbiec contract');
  }
  return { credentialId, operation, accountEmail, tenantId, requestId };
}

function accountEmail(account) {
  return String(account.metadata?.email ?? account.username ?? '').trim().toLowerCase();
}

function accountMatchesContract(account, contract) {
  const metadata = account?.metadata ?? {};
  return accountEmail(account) === contract.accountEmail
    && metadata.skarbiec_credential_id === contract.credentialId
    && (metadata.skarbiec_tenant_id ?? null) === (contract.tenantId ?? null);
}

function generatedPassword() {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!#$%&()*+,-.:;<=>?@[]^_{|}~',
  ];
  const all = groups.join('');
  const chars = groups.map((group) => group[randomInt(group.length)]);
  while (chars.length < Number('32')) chars.push(all[randomInt(all.length)]);
  for (let index = chars.length - Number('1'); index > Number('0'); index -= Number('1')) {
    const target = randomInt(index + Number('1'));
    [chars[index], chars[target]] = [chars[target], chars[index]];
  }
  return chars.join('');
}

async function visible(locator) {
  const count = await locator.count().catch(() => Number('0'));
  return count > Number('0') && locator.first().isVisible().catch(() => false);
}


async function choosePasswordSignIn(page, selectPassword = true) {
  const passkeyPage = page.getByText(/Face, fingerprint, PIN or security key|device will open a security window/i).first();
  if (await visible(passkeyPage)) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(Number('500'));
    const resume = await page.evaluate(
      () => globalThis.$Config?.urlCancel ?? globalThis.$Config?.urlResume ?? '',
    ).catch(() => '');
    if (resume) {
      const target = new URL(resume, page.url());
      if (!['login.live.com', 'login.microsoft.com'].includes(target.hostname)) {
        throw new Error('Microsoft passkey resume URL escaped the login origin');
      }
      await page.goto(target.href, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(Number('1000'));
    } else {
      const back = page.locator('#idBtn_Back, button[aria-label="Back"]').first();
      if (await visible(back)) {
        await back.click();
        await page.waitForTimeout(Number('1000'));
      }
    }
  }
  const otherWays = page.getByText(/Other ways to sign in|Sign-in options|Use another way/i).first();
  if (await visible(otherWays)) {
    await otherWays.click();
    await page.waitForTimeout(Number('1000'));
  }
  if (selectPassword) {
    const passwordChoice = page.getByText(/Use (?:your )?password|Password/i).first();
    if (await visible(passwordChoice)) {
      await passwordChoice.click();
      await page.waitForTimeout(Number('1000'));
    }
  }
}

async function fill(page, locator, value) {
  await locator.waitFor({ state: 'visible', timeout: Number('30000') });
  await humanClickLocator(page, locator);
  await locator.fill('');
  await humanType(page, value);
}

async function hasIdentityChallenge(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  return IDENTITY_CHALLENGE.test(body);
}
async function waitForVerificationCode(page) {
  const codeFile = process.env.MICROSOFT_VERIFICATION_CODE_FILE?.trim() ?? '';
  if (!codeFile) return null;
  if (!isAbsolute(codeFile) || basename(codeFile) !== 'microsoft-verification-code') {
    throw new Error('invalid Microsoft verification-code file path');
  }
  const expectedMode = Number.parseInt('600', Number('8'));
  const deadline = Date.now() + Number('300000');
  while (Date.now() < deadline) {
    try {
      const metadata = statSync(codeFile);
      if (!metadata.isFile()
          || metadata.uid !== process.getuid()
          || (metadata.mode & Number.parseInt('777', Number('8'))) !== expectedMode
          || metadata.size > Number('32')) {
        throw new Error('Microsoft verification-code file failed owner, mode, or size validation');
      }
      const code = readFileSync(codeFile, 'utf8').trim();
      if (!/^\d{4,8}$/.test(code)) {
        throw new Error('Microsoft verification-code file contains an invalid code');
      }
      unlinkSync(codeFile);
      return code;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await page.waitForTimeout(Number('1000'));
  }
  return null;
}

async function completeEmailIdentityChallenge(page, email) {
  let sendEmail = page.getByRole('group', {
    name: new RegExp(`Send a code to ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
  }).first();
  if (!await visible(sendEmail)) {
    const otherOption = page.getByText(
      /Use a different verification option|Other ways to verify|Use another way/i,
    ).first();
    if (await visible(otherOption)) {
      await humanClickLocator(page, otherOption);
      await humanIdlePause('long');
    }
    sendEmail = page.getByLabel(/Email.*@/i).last();
    if (!await visible(sendEmail)) {
      sendEmail = page.getByText(/Email.*@|Send a code to.*@/i).last();
    }
  }
  if (!await visible(sendEmail)) return false;
  await sendEmail.click();
  const requestCode = page.getByRole('button', { name: /Get code|Send code|Next/i }).first();
  if (await visible(requestCode)) {
    await humanClickLocator(page, requestCode);
    await humanIdlePause('long');
  }
  await page.waitForTimeout(Number('1500'));

  let body = await page.locator('body').innerText().catch(() => '');
  let visibleInput = page.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"])').first();
  if (/enter.{0,40}(email|address)|confirm.{0,40}(email|address)|matches the email address|email address on your account/i.test(body)
      && await visible(visibleInput)) {
    await fill(page, visibleInput, email);
    const send = page.getByRole('button', { name: /Next|Send code|Send/i }).first();
    if (!await visible(send)) return false;
    await humanClickLocator(page, send);
    await page.waitForTimeout(Number('1500'));
  }

  body = await page.locator('body').innerText().catch(() => '');
  if (!/code/i.test(body)) return false;
  visibleInput = page.locator(
    'input[type="tel"], input[type="number"], input[inputmode="numeric"], input[name*="otc" i], input[name*="code" i], input[type="text"]',
  ).first();
  if (!await visible(visibleInput)) return false;
  const code = await waitForVerificationCode(page);
  if (!code) return false;
  visibleInput = page.locator(
    'input[type="tel"], input[type="number"], input[inputmode="numeric"], input[name*="otc" i], input[name*="code" i], input[type="text"]',
  ).first();
  await fill(page, visibleInput, code);
  const verify = page.getByRole('button', { name: /Verify|Next|Submit|Continue/i }).first();
  if (!await visible(verify)) return false;
  await humanClickLocator(page, verify);
  await humanIdlePause('long');
  let passwordPage = null;
  let statePage = page;
  const deadline = Date.now() + Number('150000');
  while (Date.now() < deadline && !passwordPage) {
    const pages = page.context().pages().filter((candidate) => !candidate.isClosed()).reverse();
    for (const candidate of pages) {
      if (/account\.live\.com\/password\/Change/i.test(candidate.url())) statePage = candidate;
      const candidateBody = await candidate.locator('body').innerText().catch(() => '');
      if (/stay signed in/i.test(candidateBody)) {
        const no = candidate.getByRole('button', { name: /^No$/i }).first();
        if (await visible(no)) {
          await humanClickLocator(candidate, no);
          await humanIdlePause('long');
        }
      }
      if (await visible(candidate.locator('input[type="password"]').nth(Number('1')))) {
        passwordPage = candidate;
        statePage = candidate;
        break;
      }
    }
    if (!passwordPage) await page.waitForTimeout(Number('1000'));
  }
  const passwordReady = Boolean(passwordPage);
  const resultBody = await statePage.locator('body').innerText().catch(() => '');
  if (!passwordReady
      && /code.{0,40}(incorrect|invalid|expired|didn.t work)|wrong.{0,20}code/i.test(resultBody)) {
    throw new Error('Microsoft email verification code was rejected');
  }
  writeFileSync(join(runRecordingsDir(), 'microsoft_identity_state.json'), JSON.stringify({
    stage: 'email_challenge_complete',
    passwordReady,
    passwordCount: await statePage.locator('input[type="password"]').count(),
    pageCount: page.context().pages().length,
    url: statePage.url(),
    title: await statePage.title().catch(() => ''),
    body: resultBody,
    inputs: await statePage.locator('input').evaluateAll((nodes) => nodes.map((node) => ({
      type: node.getAttribute('type'),
      name: node.getAttribute('name'),
      id: node.id,
      ariaLabel: node.getAttribute('aria-label'),
      autocomplete: node.getAttribute('autocomplete'),
      outerHTML: node.outerHTML.slice(0, Number('1000')),
    }))).catch(() => []),
  }, null, Number('2')));
  return passwordPage;
}


async function verifyPassword(session, email, password) {
  await session.ctx.clearCookies();
  await session.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const emailInput = session.page.locator('input[name="loginfmt"], input#i0116, input[type="email"]').first();
  await fill(session.page, emailInput, email);
  const next = session.page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first();
  await humanClickLocator(session.page, next);
  await humanIdlePause('deliberate');
  await choosePasswordSignIn(session.page);
  const passwordInput = session.page.locator('input[name="passwd"], input#i0118, input[type="password"]').first();
  if (!await visible(passwordInput)) return false;
  await fill(session.page, passwordInput, password);
  const submit = session.page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first();
  await humanClickLocator(session.page, submit);
  await humanIdlePause('long');
  const body = await session.page.locator('body').innerText().catch(() => '');
  if (/incorrect|wrong password|password is invalid|try again/i.test(body)) return false;
  if (await visible(session.page.locator('input[name="passwd"], input#i0118'))) return false;
  if (IDENTITY_CHALLENGE.test(body)) return true;
  return /stay signed in/i.test(body) || !/login\.live\.com\/login/i.test(session.page.url());
}

async function changePassword(session, email, currentPassword, nextPassword) {
  let page = session.page;
  if (process.env.MICROSOFT_ALLOW_UNKNOWN_CURRENT_PASSWORD_RECOVERY === '1') {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'PublicKeyCredential', {
        configurable: true,
        value: undefined,
      });
    });
  }
  await page.goto(PASSWORD_CHANGE_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await choosePasswordSignIn(page);
  if (process.env.MICROSOFT_ALLOW_UNKNOWN_CURRENT_PASSWORD_RECOVERY === '1') {
    const emailInput = page.locator(
      'input[name="loginfmt"], input#i0116, input[type="email"]',
    ).first();
    await emailInput.waitFor({ state: 'visible', timeout: Number('45000') }).catch(() => {});
    if (await visible(emailInput)) {
      await fill(page, emailInput, email);
      const next = page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first();
      await humanClickLocator(page, next);
      await humanIdlePause('deliberate');
    }
    const resetUrl = await page.evaluate(
      () => globalThis.$Config?.urlResetPassword ?? globalThis.ServerData?.urlResetPassword ?? '',
    ).catch(() => '');
    if (resetUrl) {
      const target = new URL(resetUrl, page.url());
      if (target.hostname !== 'account.live.com') {
        throw new Error('Microsoft password reset URL escaped the account origin');
      }
      await page.goto(target.href, { waitUntil: 'domcontentloaded' });
      await humanIdlePause('long');
      await page.keyboard.press('Escape').catch(() => {});
      const passkeyBack = page.locator('#idBtn_Back, button[aria-label="Back"]').first();
      if (await passkeyBack.count().catch(() => Number('0'))) {
        await passkeyBack.evaluate((element) => element.click()).catch(() => {});
        await humanIdlePause('long');
      }
      const recoveryBody = await page.locator('body').innerText().catch(() => '');
      const resumeUrl = await page.evaluate(
        () => globalThis.$Config?.urlCancel
          ?? globalThis.$Config?.urlResume
          ?? globalThis.ServerData?.urlCancel
          ?? globalThis.ServerData?.urlResume
          ?? '',
      ).catch(() => '');
      if (/security window|try again/i.test(recoveryBody) && resumeUrl) {
        const resumeTarget = new URL(resumeUrl, page.url());
        if (!['login.live.com', 'login.microsoft.com'].includes(resumeTarget.hostname)) {
          throw new Error('Microsoft recovery resume URL escaped the login origin');
        }
        await page.goto(resumeTarget.href, { waitUntil: 'domcontentloaded' });
        await humanIdlePause('long');
      }
      await choosePasswordSignIn(page, false);
      const recoveryEmail = page.locator(
        'input#iSigninName, input[name="iSigninName"], input[type="email"]',
      ).first();
      await recoveryEmail.waitFor({ state: 'visible', timeout: Number('45000') }).catch(() => {});
      if (await visible(recoveryEmail)) {
        await fill(page, recoveryEmail, email);
        const recoveryNext = page.getByRole('button', { name: /^Next$/i }).first();
        if (await visible(recoveryNext)) {
          await humanClickLocator(page, recoveryNext);
        } else {
          await humanClickLocator(page, page.locator('input[type="submit"]').first());
        }
        await humanIdlePause('long');
      }
    } else {
      const forgotPassword = page.getByText(/Forgot password|Reset password/i).first();
      await forgotPassword.waitFor({ state: 'visible', timeout: Number('45000') }).catch(() => {});
      if (await visible(forgotPassword)) {
        await humanClickLocator(page, forgotPassword);
        await humanIdlePause('long');
      }
    }
  }

  let newPasswordInput = page.locator(
    'input#iPassword, input[name="Password"][aria-label*="New password" i]',
  ).first();
  let retypePasswordInput = page.locator(
    'input#iRetypePassword, input[name="RetypePassword"]',
  ).first();
  let dedicatedFormReady = await visible(newPasswordInput) && await visible(retypePasswordInput);

  if (!dedicatedFormReady) {
    const challengePage = await completeEmailIdentityChallenge(page, email);
    if (challengePage) page = challengePage;
    newPasswordInput = page.locator(
      'input#iPassword, input[name="Password"][aria-label*="New password" i]',
    ).first();
    retypePasswordInput = page.locator(
      'input#iRetypePassword, input[name="RetypePassword"]',
    ).first();
    await newPasswordInput.waitFor({ state: 'visible', timeout: Number('120000') }).catch(() => {});
    dedicatedFormReady = await visible(newPasswordInput) && await visible(retypePasswordInput);
  }

  if (dedicatedFormReady) {
    await fill(page, newPasswordInput, nextPassword);
    await fill(page, retypePasswordInput, nextPassword);
    const submit = page.locator('input#UpdatePasswordAction, button[type="submit"], input[type="submit"]').first();
    await humanClickLocator(page, submit);
  } else {
    const passwordInputs = page.locator('input[type="password"]');
    const count = await passwordInputs.count();
    if (count < Number('2')) return 'unavailable';
    if (count >= Number('3')) {
      await fill(page, passwordInputs.nth(Number('0')), currentPassword);
    }
    await fill(page, passwordInputs.nth(count - Number('2')), nextPassword);
    await fill(page, passwordInputs.nth(count - Number('1')), nextPassword);
    const submit = page.locator('button[type="submit"], input[type="submit"]').first();
    await humanClickLocator(page, submit);
  }

  await humanIdlePause('long');
  const body = await page.locator('body').innerText().catch(() => '');
  if (/couldn.t change|try again|incorrect|error/i.test(body)) return 'rejected';
  return /password.{0,40}(changed|updated|success)/i.test(body)
    || /account\.microsoft\.com\/security/i.test(page.url())
    || !await visible(page.locator('input#iPassword, input[type="password"]'))
    ? 'changed'
    : 'ambiguous';
}

async function rollbackPassword(session, email, currentPassword, previousPassword) {
  await changePassword(session, email, currentPassword, previousPassword);
  return verifyPassword(session, email, previousPassword);
}

function pendingReview(reason, page) {
  writeFileSync(join(runRecordingsDir(), 'pending_review.json'), JSON.stringify({
    status: 'needs_human_approval',
    reason,
    url: page.url(),
  }, null, Number('2')));
}

function updateAccountReference(account, credentialId, tenantId) {
  if (!account.id) throw new Error('Microsoft account has no stable Skarbiec id');
  const metadata = { ...(account.metadata ?? {}), skarbiec_credential_id: credentialId };
  delete metadata.password;
  if (tenantId) metadata.skarbiec_tenant_id = tenantId;
  else delete metadata.skarbiec_tenant_id;
  if (!updateAccount(account.id, { metadata })) {
    throw new Error('Microsoft account credential-reference update failed');
  }
}

async function openSession(account, label) {
  const { proxyUrl, persona } = await resolveAccountSession(account);
  const session = await WSession.start({ label, proxy: proxyUrl, persona });
  return { session, proxyUrl };
}

export async function verifyMicrosoftPassword() {
  const contract = constraints('verify');
  const account = await getSocialAccount('microsoft');
  if (!account || !accountMatchesContract(account, contract)) {
    throw new Error('queued Microsoft account does not match the exact credential account');
  }
  const password = readWelesManagedCredential(
    contract.credentialId,
    PASSWORD_FIELD,
    contract.tenantId,
  );
  if (!password) throw new Error('managed Microsoft password is unavailable from Skarbiec');
  const { session, proxyUrl } = await openSession(account, 'microsoft_verify_password');
  try {
    if (!await verifyPassword(session, contract.accountEmail, password)) {
      if (await hasIdentityChallenge(session.page)) {
        pendingReview('Microsoft requires interactive identity approval to verify the managed password', session.page);
        return { status: 'needs_human_approval' };
      }
      throw new Error('fresh Microsoft password authentication failed');
    }
    const secret = Buffer.from(password, 'utf8');
    try {
      writeWelesAcquiredSecret(
        contract.credentialId,
        PASSWORD_FIELD,
        secret,
        contract.tenantId,
        {
          accountEmail: contract.accountEmail,
          requestId: contract.requestId,
          operation: contract.operation,
        },
      );
    } finally {
      secret.fill(Number('0'));
    }
    const cookies = await session.ctx.cookies();
    await persistFreshCookieJar(account, cookies, { currentProxyUrl: proxyUrl });
    return { status: 'verified' };
  } finally {
    await session.close().catch(() => {});
  }
}

// adopt takes over a password the operator already knows. Skarbiec stages that
// candidate under the item, bound to this request id; this run reads the staged
// value through the scoped managed-credential reader and proves it with a fresh
// login. Skarbiec activates the staged revision itself on operation_completed
// and refuses every Weles write for an adopt, so this run writes nothing and
// never touches the value the provider holds.
export async function adoptMicrosoftPassword() {
  const operation = 'adopt';
  const contract = constraints(operation);
  const account = await getSocialAccount('microsoft');
  if (!account || !accountMatchesContract(account, contract)) {
    throw new Error('queued Microsoft account does not match the exact credential account');
  }
  let candidate;
  try {
    candidate = readWelesManagedCredential(
      contract.credentialId,
      PASSWORD_FIELD,
      contract.tenantId,
    );
  } catch {
    candidate = undefined;
  }
  if (!candidate) throw new Error('staged Microsoft password candidate is unavailable from Skarbiec');
  const { session, proxyUrl } = await openSession(account, 'microsoft_adopt_password');
  try {
    if (!await verifyPassword(session, contract.accountEmail, candidate)) {
      if (await hasIdentityChallenge(session.page)) {
        pendingReview('Microsoft requires interactive identity approval before the staged password candidate can be adopted', session.page);
        return { status: 'needs_human_approval' };
      }
      throw new Error('staged Microsoft password candidate failed a fresh Microsoft login');
    }
    const cookies = await session.ctx.cookies();
    await persistFreshCookieJar(account, cookies, { currentProxyUrl: proxyUrl });
    return { status: 'adopted' };
  } finally {
    await session.close().catch(() => {});
  }
}

export async function rotateMicrosoftPassword() {
  const operation = 'rotate';
  const contract = constraints(operation);
  const account = await getSocialAccount('microsoft');
  if (!account || !accountMatchesContract(account, contract)) {
    throw new Error('queued Microsoft account does not match the exact credential account');
  }
  let currentPassword;
  try {
    currentPassword = readWelesManagedCredential(
      contract.credentialId,
      PASSWORD_FIELD,
      contract.tenantId,
    );
  } catch {
    currentPassword = undefined;
  }
  const nextPassword = generatedPassword();
  const { session, proxyUrl } = await openSession(account, 'microsoft_reset_password');
  try {
    const allowUnknownCurrentPasswordRecovery =
      process.env.MICROSOFT_ALLOW_UNKNOWN_CURRENT_PASSWORD_RECOVERY === '1';
    if (!currentPassword && !allowUnknownCurrentPasswordRecovery) {
      pendingReview('Microsoft password rotation requires one known current password for rollback safety', session.page);
      return { status: 'needs_human_approval' };
    }
    if (currentPassword
        && !await verifyPassword(session, contract.accountEmail, currentPassword)
        && !allowUnknownCurrentPasswordRecovery) {
      if (await hasIdentityChallenge(session.page)) {
        pendingReview('Microsoft requires interactive identity approval before password rotation', session.page);
        return { status: 'needs_human_approval' };
      }
      throw new Error('current Microsoft password failed before rotation');
    }
    const changeResult = await changePassword(session, contract.accountEmail, currentPassword, nextPassword);
    if (changeResult === 'unavailable') {
      pendingReview('Microsoft requires interactive identity verification before password rotation', session.page);
      return { status: 'needs_human_approval' };
    }
    if (changeResult !== 'changed') {
      if (await verifyPassword(session, contract.accountEmail, currentPassword)) {
        throw new Error('Microsoft rejected the password change; the current password remains valid');
      }
      if (await verifyPassword(session, contract.accountEmail, nextPassword)) {
        const rolledBack = await rollbackPassword(
          session,
          contract.accountEmail,
          nextPassword,
          currentPassword,
        );
        if (rolledBack) throw new Error('Microsoft returned an ambiguous change response; provider password was rolled back');
      }
      throw new Error('Microsoft password change outcome is ambiguous and automatic rollback failed');
    }
    if (!await verifyPassword(session, contract.accountEmail, nextPassword)) {
      const rolledBack = await rollbackPassword(
        session,
        contract.accountEmail,
        nextPassword,
        currentPassword,
      );
      if (!rolledBack) {
        throw new Error('fresh Microsoft login failed and compensating password rollback also failed');
      }
      throw new Error('fresh Microsoft login failed; provider password was rolled back');
    }
    const secret = Buffer.from(nextPassword, 'utf8');
    try {
      writeWelesAcquiredSecret(
        contract.credentialId,
        PASSWORD_FIELD,
        secret,
        contract.tenantId,
        {
          accountEmail: contract.accountEmail,
          requestId: contract.requestId,
          operation: contract.operation,
        },
      );
      await updateAccountReference(account, contract.credentialId, contract.tenantId);
    } catch (error) {
      const providerRolledBack = await rollbackPassword(
        session,
        contract.accountEmail,
        nextPassword,
        currentPassword,
      );
      if (!providerRolledBack) {
        try {
          writeWelesAcquiredSecret(
            contract.credentialId,
            PASSWORD_FIELD,
            secret,
            contract.tenantId,
            {
              accountEmail: contract.accountEmail,
              requestId: contract.requestId,
              operation: contract.operation,
            },
          );
          await updateAccountReference(account, contract.credentialId, contract.tenantId);
          return { status: 'rotated' };
        } catch (forwardError) {
          throw new Error('credential commit and Microsoft rollback both failed; automatic consistency recovery failed', {
            cause: forwardError,
          });
        }
      }
      const previousSecret = Buffer.from(currentPassword, 'utf8');
      let skarbiecRolledBack = false;
      try {
        writeWelesAcquiredSecret(
          contract.credentialId,
          PASSWORD_FIELD,
          previousSecret,
          contract.tenantId,
          {
            accountEmail: contract.accountEmail,
            requestId: contract.requestId,
            operation: 'rollback',
          },
        );
        skarbiecRolledBack = true;
      } catch {
        skarbiecRolledBack = false;
      } finally {
        previousSecret.fill(Number('0'));
      }
      if (!skarbiecRolledBack) {
        throw new Error('credential commit failed and compensating rollback did not restore both Microsoft and Skarbiec', {
          cause: error,
        });
      }
      throw new Error('credential commit failed; Microsoft and Skarbiec were restored to the previous password', {
        cause: error,
      });
    } finally {
      secret.fill(Number('0'));
    }
    const cookies = await session.ctx.cookies();
    await persistFreshCookieJar(account, cookies, { currentProxyUrl: proxyUrl });
    return { status: 'rotated' };
  } finally {
    await session.close().catch(() => {});
  }
}
