/**
 * Agent tool dispatch — delegates to WSession methods.
 * Every tool call goes through WSession, which provides automatic diagnostics
 * (screenshots, DOM snapshots, video) via its _action() wrapper.
 */

import type { WSession } from '../session/wsession.js';
import type { CapabilityRef, WelesCapabilityPurpose } from '../utils/capability.js';
import { assertNonCredentialInput } from '../utils/capability.js';

export type ToolArgs = Record<string, unknown>;
type CredentialFieldClass = 'password' | 'email' | 'username' | 'token' | 'api-key';

const CAPABILITY_PURPOSES: Record<WelesCapabilityPurpose, true> = {
  'weles.browser.fill': true,
  'weles.captcha.solve': true,
  'weles.sms.verify': true,
  'weles.apple.2fa': true,
  'weles.proxy.authenticate': true,
  'weles.brama.sign': true,
};

const CREDENTIAL_FIELD_CLASSES: Record<CredentialFieldClass, true> = {
  password: true,
  email: true,
  username: true,
  token: true,
  'api-key': true,
};

function isCapabilityPurpose(value: string): value is WelesCapabilityPurpose {
  return Object.hasOwn(CAPABILITY_PURPOSES, value);
}

function isCredentialFieldClass(value: string): value is CredentialFieldClass {
  return Object.hasOwn(CREDENTIAL_FIELD_CLASSES, value);
}

function stringArg(args: ToolArgs, key: string, fallback = ''): string {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`invalid ${key}`);
  return value;
}

function literalInput(args: ToolArgs, key: string, target?: string): string {
  return assertNonCredentialInput(stringArg(args, key), target);
}

function capabilityArg(value: unknown): CapabilityRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['capability_id', 'purpose', 'resource', 'target'].includes(key))
    || !('capability_id' in value) || typeof value.capability_id !== 'string'
    || !('purpose' in value) || typeof value.purpose !== 'string'
    || !('resource' in value) || typeof value.resource !== 'string'
    || !('target' in value) || value.target !== 'weles') {
    throw new Error('invalid capability reference');
  }
  if (!isCapabilityPurpose(value.purpose)) throw new Error('invalid capability reference');
  return {
    capability_id: value.capability_id,
    purpose: value.purpose,
    resource: value.resource,
    target: value.target,
  };
}

export async function dispatch(session: WSession, tool: string, args: ToolArgs): Promise<string> {
  switch (tool) {
    case 'click': return session.click(stringArg(args, 'target'));
    case 'fill': {
      const target = stringArg(args, 'target');
      return session.fill(target, literalInput(args, 'value', target));
    }
    case 'fill_credential': {
      const fieldClass = stringArg(args, 'field_class');
      if (!isCredentialFieldClass(fieldClass)) throw new Error('invalid field_class');
      return session.fillCredential(
        stringArg(args, 'target'),
        fieldClass,
        capabilityArg(args.capability),
      );
    }
    case 'store_credential': {
      const fieldClass = stringArg(args, 'field_class');
      if (fieldClass !== 'token' && fieldClass !== 'api-key') throw new Error('invalid credential storage field_class');
      return session.storeCredential(stringArg(args, 'target'), fieldClass);
    }
    case 'focus': return session.focus(stringArg(args, 'selector'));
    case 'type_text': return session.type(literalInput(args, 'value'));
    case 'press_key': return session.press(stringArg(args, 'key', 'Enter'));
    case 'navigate': return session.goto(stringArg(args, 'url'));
    case 'scroll': return session.scroll(stringArg(args, 'direction', 'down'), args.amount ? Number(args.amount) : undefined);
    case 'wait': return session.wait(Number(args.seconds ?? 1));
    case 'read': return session.read(stringArg(args, 'question'));
    case 'select_option': return session.select(stringArg(args, 'target'), stringArg(args, 'value'));
    case 'set_control': {
      const selector = stringArg(args, 'selector');
      const value = typeof args.value === 'string' ? assertNonCredentialInput(args.value, selector) : args.value;
      return session.setControl(selector, value, args.checked);
    }
    case 'js_click': return session.jsClick(args.selector === undefined ? undefined : stringArg(args, 'selector'), args.text === undefined ? undefined : stringArg(args, 'text'));
    case 'solve_captcha': return session.solveCaptcha();
    case 'check_email': return session.checkEmail(stringArg(args, 'email'), stringArg(args, 'sender'));
    case 'generate_identity': {
      if (session.identity) return 'generated identity already available as redacted $PLATFORM_NEW_* placeholders';
      const platform = stringArg(args, 'platform', 'reddit');
      const id = await session.generateIdentity(platform);
      return `generated identity available as redacted placeholders for ${platform} username_hash=${id.username.length}:${id.username.slice(0, 2)}`;
    }
    case 'check_sms': return session.checkSms(stringArg(args, 'service'), stringArg(args, 'country', 'UK'));
    case 'poll_sms_code': return session.pollSmsCode();
    case 'save_account': return session.saveAccount(stringArg(args, 'platform'), {
      username: stringArg(args, 'username'), email: stringArg(args, 'email'), password: stringArg(args, 'password'),
      name: args.name === undefined ? undefined : stringArg(args, 'name'),
    });
    default: return `unknown tool: ${tool}`;
  }
}
