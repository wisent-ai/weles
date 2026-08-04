import type { WSession } from '../wsession.js';
import {
  acquiredSecretContract,
  isWelesAcquiredSecretValue,
  writeWelesAcquiredSecret,
  type WelesAcquiredSecret,
} from '../../secrets/scoped-service.js';

type CredentialFieldClass = 'token' | 'api-key' | 'password';

type StoreConstraints = {
  secretName: WelesAcquiredSecret;
  itemId: string;
  field: string;
  fieldClass: CredentialFieldClass;
  sourceOrigin: string;
  tenantId: string | null;
  accountEmail: string;
  requestId: string;
  operation: string;
};

type CredentialLocator = {
  count: () => Promise<number>;
  nth: (index: number) => {
    evaluate: <Value>(pageFunction: (element: Element) => Value) => Promise<Value>;
  };
};

type CredentialFrame = {
  url: () => string;
  locator: (selector: string) => CredentialLocator;
  getByLabel: (text: string, options: { exact: boolean }) => CredentialLocator;
  getByRole: (role: string, options: { name: RegExp }) => CredentialLocator;
};

type CredentialPage = {
  url: () => string;
  frames: () => CredentialFrame[];
  context?: () => { pages: () => CredentialPage[] };
};

function credentialConstraintsText(): string {
  const configured = [
    process.env.GENERIC_TASK_CONSTRAINTS,
    process.env.WELES_CREDENTIAL_CONSTRAINTS,
  ].filter((value): value is string => typeof value === 'string' && value.length > Number('0'));
  if (configured.length > Number('1')) {
    throw new Error('multiple credential constraint sources are not allowed');
  }
  return configured[0] ?? '{}';
}

export function isSkarbiecCredentialTask(): boolean {
  if (typeof process.env.WELES_CREDENTIAL_CONSTRAINTS === 'string'
      && process.env.WELES_CREDENTIAL_CONSTRAINTS.length > Number('0')) {
    return true;
  }
  try {
    const constraints: unknown = JSON.parse(credentialConstraintsText());
    return Boolean(
      constraints
      && typeof constraints === 'object'
      && !Array.isArray(constraints)
      && 'store_secret_target' in constraints
      && constraints.store_secret_target === 'skarbiec',
    );
  } catch {
    return typeof process.env.GENERIC_TASK_CONSTRAINTS === 'string'
      && process.env.GENERIC_TASK_CONSTRAINTS.length > Number('0');
  }
}

function storeConstraints(): StoreConstraints {
  let raw: unknown;
  try {
    raw = JSON.parse(credentialConstraintsText());
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
  const secretName = typeof record.secret === 'string' ? record.secret : '';
  const itemId = typeof record.vault_item_id === 'string' ? record.vault_item_id : '';
  const field = typeof record.vault_field === 'string' ? record.vault_field : '';
  const sourceOrigin = typeof record.secret_source_origin === 'string' ? record.secret_source_origin : '';
  const tenantId = typeof record.tenant_id === 'string' ? record.tenant_id : null;
  const accountEmail = typeof record.account_email === 'string' ? record.account_email.trim().toLowerCase() : '';
  const requestId = typeof record.request_id === 'string' ? record.request_id : '';
  const operation = typeof record.operation === 'string' ? record.operation : '';
  const contract = acquiredSecretContract(secretName);
  if (!contract
    || itemId !== contract.item
    || field !== contract.field
    || sourceOrigin !== contract.sourceOrigin) {
    throw new Error('credential storage target is not in the exact Weles acquisition allowlist');
  }
  const fieldClass: CredentialFieldClass = field === 'api_key'
    ? 'api-key'
    : field === 'password'
      ? 'password'
      : 'token';
  if (fieldClass === 'password' && !accountEmail) {
    throw new Error('password credential storage requires an exact account email');
  }
  if (!/^[a-f0-9]{64}$/i.test(requestId)
      || !['acquire', 'rotate', 'verify'].includes(operation)) {
    throw new Error('credential storage requires an exact request id and operation');
  }
  return {
    secretName: secretName as WelesAcquiredSecret,
    itemId,
    field,
    fieldClass,
    sourceOrigin,
    tenantId,
    accountEmail,
    requestId,
    operation,
  };
}

async function captureCandidate(
  session: WSession,
  target: string,
  secretName: WelesAcquiredSecret,
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
  const frames = authorizedPages
    .flatMap((page) => page.frames())
    .filter((frame) => {
      try {
        return new URL(frame.url()).origin === sourceOrigin;
      } catch {
        return false;
      }
    });
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
        const secret = Buffer.from(value, 'utf8');
        if (isWelesAcquiredSecretValue(secretName, secret)) return secret;
        secret.fill(Number('0'));
      }
    }
  }
  throw new Error('credential element was not found or did not match the required secret shape');
}



export async function wsStoreCredential(
  session: WSession,
  target: string,
  fieldClass: CredentialFieldClass,
): Promise<string> {
  if (!target.trim() || target.length > Number('256')) throw new Error('credential target is invalid');
  const constraints = storeConstraints();
  if (fieldClass !== constraints.fieldClass) {
    throw new Error('credential field class does not match the exact Weles acquisition allowlist');
  }

  const secret = await captureCandidate(session, target, constraints.secretName, constraints.sourceOrigin);
  try {
    writeWelesAcquiredSecret(
      constraints.secretName,
      constraints.field,
      secret,
      constraints.tenantId,
      {
        accountEmail: constraints.accountEmail,
        requestId: constraints.requestId,
        operation: constraints.operation,
      },
    );
  } finally {
    secret.fill(Number('0'));
  }
  return `credential stored in Skarbiec item ${constraints.itemId} field ${constraints.field}`;
}

export async function wsAutoStoreCredential(session: WSession): Promise<string | null> {
  if (!isSkarbiecCredentialTask()) return null;
  try {
    return await wsStoreCredential(session, 'generated credential', storeConstraints().fieldClass);
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
