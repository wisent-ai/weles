/**
 * Agent tool dispatch — delegates to WSession methods. The tools themselves
 * are declared in ./tools/declarations.ts. Every tool call goes through
 * WSession, which keeps each step's diagnostics (screenshots, DOM snapshots,
 * video).
 */

import type { WSession } from '../session/wsession.js';
import type { IdentityField } from '../session/identity/generated.js';
import type {
  CapabilityRef,
  WelesCapabilityPurpose,
} from '../utils/capability.js';
import { assertNonCredentialInput } from '../utils/capability.js';
import { enforceBrowserEvidenceToolPolicy } from './browser-evidence-policy/interactive-control/tool-dispatch.js';
import { hashDiagnosticValue } from '../session/wsession/run-provenance.js';
import {
  CAPABILITY_PURPOSES,
  CREDENTIAL_FIELD_CLASSES,
  IDENTITY_FIELDS,
  type CredentialFieldClass,
} from './tools/declarations.js';

export { BROWSER_TOOLS, DECIDED_ON_LIVE_PAGE } from './tools/declarations.js';

export type ToolArgs = Record<string, unknown>;

type WaitState = 'attached' | 'visible' | 'hidden' | 'detached';
const WAIT_STATES: Record<WaitState, true> = {
  attached: true,
  visible: true,
  hidden: true,
  detached: true,
};
/** The locator state wait_for waits for when the call names none, as its declaration says. */
const DEFAULT_WAIT_STATE: WaitState = 'visible';

function isCapabilityPurpose(value: string): value is WelesCapabilityPurpose {
  return Object.hasOwn(CAPABILITY_PURPOSES, value);
}

function isCredentialFieldClass(value: string): value is CredentialFieldClass {
  return Object.hasOwn(CREDENTIAL_FIELD_CLASSES, value);
}

function isIdentityField(value: string): value is IdentityField {
  return Object.hasOwn(IDENTITY_FIELDS, value);
}

function isWaitState(value: string): value is WaitState {
  return Object.hasOwn(WAIT_STATES, value);
}

function stringArg(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== 'string')
    throw new Error(
      `invalid ${key}: expected a string, received ${value === null ? 'null' : typeof value}`,
    );
  return value;
}

function literalInput(args: ToolArgs, key: string): string {
  return assertNonCredentialInput(stringArg(args, key));
}

function waitState(args: ToolArgs): WaitState {
  if (args.state === undefined) return DEFAULT_WAIT_STATE;
  const state = stringArg(args, 'state');
  if (!isWaitState(state))
    throw new Error(
      `invalid state: ${state} is not one of ${Object.keys(WAIT_STATES).join(', ')}`,
    );
  return state;
}

function capabilityArg(value: unknown): CapabilityRef {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        !['capability_id', 'purpose', 'resource', 'target'].includes(key),
    ) ||
    !('capability_id' in value) ||
    typeof value.capability_id !== 'string' ||
    !('purpose' in value) ||
    typeof value.purpose !== 'string' ||
    !('resource' in value) ||
    typeof value.resource !== 'string' ||
    !('target' in value) ||
    value.target !== 'weles'
  ) {
    throw new Error('invalid capability reference');
  }
  if (!isCapabilityPurpose(value.purpose))
    throw new Error('invalid capability reference');
  return {
    capability_id: value.capability_id,
    purpose: value.purpose,
    resource: value.resource,
    target: value.target,
  };
}

export async function dispatch(
  session: WSession,
  tool: string,
  args: ToolArgs,
): Promise<string> {
  const authorization = await enforceBrowserEvidenceToolPolicy(
    session,
    tool,
    args,
  );
  if (authorization) return authorization.invoke();
  switch (tool) {
    case 'click':
      return session.click(stringArg(args, 'target'));
    case 'fill':
      return session.fill(
        stringArg(args, 'target'),
        literalInput(args, 'value'),
      );
    case 'fill_credential': {
      const fieldClass = stringArg(args, 'field_class');
      if (!isCredentialFieldClass(fieldClass))
        throw new Error('invalid field_class');
      return session.fillCredential(
        stringArg(args, 'target'),
        fieldClass,
        capabilityArg(args.capability),
      );
    }
    case 'fill_identity': {
      const field = stringArg(args, 'field');
      if (!isIdentityField(field)) throw new Error('invalid identity field');
      return session.fillIdentity(stringArg(args, 'target'), field);
    }
    case 'store_credential': {
      const fieldClass = stringArg(args, 'field_class');
      if (fieldClass !== 'token' && fieldClass !== 'api-key')
        throw new Error('invalid credential storage field_class');
      return session.storeCredential(stringArg(args, 'target'), fieldClass);
    }
    case 'focus':
      return session.focus(stringArg(args, 'selector'));
    case 'type_text':
      return session.type(literalInput(args, 'value'));
    case 'press_key':
      return session.press(stringArg(args, 'key'));
    case 'navigate':
      return session.goto(stringArg(args, 'url'));
    case 'scroll':
      return session.scroll(
        stringArg(args, 'direction'),
        args.amount === undefined ? undefined : Number(args.amount),
      );
    case 'wait_for':
      return session.waitFor(stringArg(args, 'selector'), {
        state: waitState(args),
      });
    case 'read':
      return session.read(stringArg(args, 'question'));
    case 'select_option':
      return session.select(
        stringArg(args, 'target'),
        stringArg(args, 'value'),
      );
    case 'set_control': {
      const selector = stringArg(args, 'selector');
      const value =
        typeof args.value === 'string'
          ? assertNonCredentialInput(args.value)
          : args.value;
      return session.setControl(selector, value, args.checked);
    }
    case 'js_click':
      return session.jsClick(
        args.selector === undefined ? undefined : stringArg(args, 'selector'),
        args.text === undefined ? undefined : stringArg(args, 'text'),
      );
    case 'solve_captcha':
      return session.solveCaptcha();
    case 'check_email':
      return session.newestMail(
        stringArg(args, 'email'),
        stringArg(args, 'sender'),
      );
    case 'generate_identity': {
      if (session.identity)
        return 'generated identity already available; use fill_identity for its fields';
      const platform = stringArg(args, 'platform');
      const id = await session.generateIdentity(platform);
      return `generated identity ready for fill_identity platform=${platform} username_hash=${hashDiagnosticValue(id.username)}`;
    }
    case 'check_sms':
      return session.checkSms(
        stringArg(args, 'service'),
        stringArg(args, 'country'),
      );
    case 'poll_sms_code':
      return session.textedCode();
    case 'save_account':
      return session.saveAccount(stringArg(args, 'platform'), {
        username: stringArg(args, 'username'),
        email: stringArg(args, 'email'),
        password: stringArg(args, 'password'),
        name: args.name === undefined ? undefined : stringArg(args, 'name'),
      });
    default:
      throw new Error(
        `UNKNOWN_TOOL: ${tool} is not one of the declared browser tools`,
      );
  }
}
