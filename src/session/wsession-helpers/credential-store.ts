import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { WSession } from '../wsession.js';

type CredentialFieldClass = 'token' | 'api-key';

type StoreConstraints = {
  itemId: string;
  expectedPrefix: string;
  sourceOrigin: string;
};

type CredentialLocator = {
  count: () => Promise<number>;
  nth: (index: number) => {
    evaluate: <Value>(pageFunction: (element: Element) => Value) => Promise<Value>;
  };
};

type CredentialFrame = {
  locator: (selector: string) => CredentialLocator;
  getByLabel: (text: string, options: { exact: boolean }) => CredentialLocator;
  getByRole: (role: string, options: { name: RegExp }) => CredentialLocator;
};

type CredentialPage = {
  url: () => string;
  frames: () => CredentialFrame[];
  context?: () => { pages: () => CredentialPage[] };
};

export function isSkarbiecCredentialTask(): boolean {
  try {
    const constraints: unknown = JSON.parse(process.env.GENERIC_TASK_CONSTRAINTS ?? '{}');
    return Boolean(
      constraints
      && typeof constraints === 'object'
      && !Array.isArray(constraints)
      && 'store_secret_target' in constraints
      && constraints.store_secret_target === 'skarbiec',
    );
  } catch {
    return false;
  }
}

function storeConstraints(): StoreConstraints {
  let raw: unknown;
  try {
    raw = JSON.parse(process.env.GENERIC_TASK_CONSTRAINTS ?? '{}');
  } catch {
    throw new Error('credential storage constraints are invalid');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('credential storage constraints are invalid');
  }
  const record = raw as Record<string, unknown>;
  if (record.store_secret_target !== 'skarbiec') {
    throw new Error('credential storage is not authorized for this task');
  }
  const itemId = typeof record.vault_item_id === 'string' ? record.vault_item_id : '';
  const expectedPrefix = typeof record.expected_secret_prefix === 'string' ? record.expected_secret_prefix : '';
  const sourceOrigin = typeof record.secret_source_origin === 'string' ? record.secret_source_origin : '';
  if (!itemId || itemId.length > 256 || /[\u0000-\u001f\u007f]/.test(itemId)) {
    throw new Error('credential storage item id is invalid');
  }
  if (!expectedPrefix || expectedPrefix.length > 32 || /\s/.test(expectedPrefix)) {
    throw new Error('credential storage prefix is invalid');
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(sourceOrigin)) {
    throw new Error('credential storage source origin is invalid');
  }
  return { itemId, expectedPrefix, sourceOrigin };
}

async function skarbiecCLI(): Promise<string> {
  const configured = process.env.SKARBIEC_CLI?.trim();
  const candidates = [
    configured,
    resolve(__dirname, '../../../../entitlements-rotator/target/release/skarbiec-entitlements-router'),
    resolve(__dirname, '../../../../entitlements-rotator/target/debug/skarbiec-entitlements-router'),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next explicit, release, or debug candidate.
    }
  }
  throw new Error('Skarbiec credential backend is unavailable');
}

async function captureCandidate(
  session: WSession,
  target: string,
  expectedPrefix: string,
  sourceOrigin: string,
): Promise<Buffer> {
  const rootPage = session.page as CredentialPage;
  const pages = rootPage.context?.().pages() ?? [rootPage];
  const authorizedPages = pages.filter((page) => {
    try {
      return new URL(page.url()).origin === sourceOrigin;
    } catch {
      return false;
    }
  });
  if (authorizedPages.length === 0) throw new Error('credential source origin mismatch');
  const frames = authorizedPages.flatMap((page) => page.frames());
  const keyword = target.toLowerCase().replace(/[^a-z0-9_-]+/g, ' ').trim().split(/\s+/).find((part) => part.length >= 3) ?? '';
  for (const frame of frames) {
    const locators: CredentialLocator[] = [];
    if (/^(#|\.|\[|input|textarea|code|pre)/.test(target.trim())) {
      locators.push(frame.locator(target));
    }
    try { locators.push(frame.getByLabel(target, { exact: false })); } catch {}
    try { locators.push(frame.getByRole('textbox', { name: new RegExp(target, 'i') })); } catch {}
    const escapedKeyword = keyword.replace(/["\\]/g, '\\$&');
    locators.push(frame.locator([
      'input[readonly]',
      'textarea[readonly]',
      'input',
      'textarea',
      'code',
      '[data-testid*="token" i]',
      '[data-testid*="key" i]',
      '[class*="token" i]',
      '[class*="api-key" i]',
      escapedKeyword ? `[aria-label*="${escapedKeyword}" i]` : '',
    ].filter(Boolean).join(',')));

    for (const locator of locators) {
      const count = Math.min(await locator.count().catch(() => 0), 64);
      for (let index = 0; index < count; index += 1) {
        const candidate = await locator.nth(index).evaluate((element: Element) => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
          return element.textContent ?? '';
        }).catch(() => '');
        const value = String(candidate).trim();
        if (!value.startsWith(expectedPrefix) || value.length < expectedPrefix.length + 12 || value.length > 8192 || /\s/.test(value)) continue;
        return Buffer.from(value, 'utf8');
      }
    }
    const bodyText = await frame.locator('body').nth(0).evaluate((element: Element) => element.textContent ?? '').catch(() => '');
    const escapedPrefix = expectedPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bodyMatch = String(bodyText).match(new RegExp(`${escapedPrefix}[A-Za-z0-9._-]{12,8180}`));
    if (bodyMatch) return Buffer.from(bodyMatch[0], 'utf8');
  }
  throw new Error('credential element was not found or did not match the required secret shape');
}

async function runSkarbiec(
  cli: string,
  arguments_: string[],
  childEnvironment: Record<string, string>,
  standardInput: Buffer | null,
  operation: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(cli, arguments_, {
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.reduce((total, part) => total + part.length, 0) < 65_536) stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((total, part) => total + part.length, 0) < 4096) stderr.push(Buffer.from(chunk));
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 240);
      reject(new Error(detail ? `Skarbiec ${operation} failed: ${detail}` : `Skarbiec ${operation} failed with exit ${code ?? 'unknown'}`));
    });
    child.stdin.end(standardInput ?? undefined);
  });
}

function requireSuccessfulSync(output: Buffer, operation: string): void {
  let response: { ok?: unknown; detail?: unknown };
  try {
    response = JSON.parse(output.toString('utf8')) as { ok?: unknown; detail?: unknown };
  } catch {
    throw new Error(`Skarbiec ${operation} returned malformed JSON`);
  }
  if (response.ok !== true) {
    const detail = typeof response.detail === 'string' ? response.detail.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    throw new Error(detail ? `Skarbiec ${operation} failed: ${detail}` : `Skarbiec ${operation} failed`);
  }
}

async function writeCredential(cli: string, itemId: string, secret: Buffer): Promise<void> {
  const childEnvironment: Record<string, string> = {
    PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? '',
  };
  for (const key of ['GNUPGHOME', 'SKARBIEC_VAULT_FILE', 'SKARBIEC_AUDIT_FILE', 'SKARBIEC_UNLOCK', 'SKARBIEC_SYNC_DIR']) {
    const value = process.env[key]?.trim();
    if (value) childEnvironment[key] = value;
  }
  if (childEnvironment.SKARBIEC_SYNC_DIR) {
    const pullOutput = await runSkarbiec(cli, ['sync-pull'], childEnvironment, null, 'credential sync pull');
    requireSuccessfulSync(pullOutput, 'credential sync pull');
  }
  await runSkarbiec(cli, ['credential-put', itemId], childEnvironment, secret, 'credential write');
  if (childEnvironment.SKARBIEC_SYNC_DIR) {
    const pushOutput = await runSkarbiec(
      cli,
      ['sync-push', '--message=weles credential acquisition'],
      childEnvironment,
      null,
      'credential sync push',
    );
    requireSuccessfulSync(pushOutput, 'credential sync push');
  }
}

export async function wsStoreCredential(
  session: WSession,
  target: string,
  fieldClass: CredentialFieldClass,
): Promise<string> {
  if (!target.trim() || target.length > 256) throw new Error('credential target is invalid');
  if (fieldClass !== 'token' && fieldClass !== 'api-key') throw new Error('credential field class is invalid');
  const constraints = storeConstraints();

  const secret = await captureCandidate(session, target, constraints.expectedPrefix, constraints.sourceOrigin);
  try {
    const cli = await skarbiecCLI();
    await writeCredential(cli, constraints.itemId, secret);
  } finally {
    secret.fill(0);
  }
  return `credential stored in Skarbiec item ${constraints.itemId}`;
}

export async function wsAutoStoreCredential(session: WSession): Promise<string | null> {
  if (!isSkarbiecCredentialTask()) return null;
  try {
    return await wsStoreCredential(session, 'generated credential', 'token');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message === 'credential source origin mismatch'
      || message === 'credential element was not found or did not match the required secret shape'
    ) {
      return null;
    }
    throw error;
  }
}
