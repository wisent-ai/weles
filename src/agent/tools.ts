/**
 * Agent tool dispatch — delegates to WSession methods.
 * Every tool call goes through WSession, which provides automatic diagnostics
 * (screenshots, DOM snapshots, video) via its _action() wrapper.
 */

import type { WSession } from '../session/wsession.js';
import type { CapabilityRef, WelesCapabilityPurpose } from '../utils/capability.js';
import { assertNonCredentialInput } from '../utils/capability.js';
import { enforceBrowserEvidenceToolPolicy } from './browser-evidence-policy.js';
import type { FunctionTool } from './jeden.js';

export type ToolArgs = Record<string, unknown>;
type CredentialFieldClass = 'password' | 'email' | 'username' | 'token' | 'api-key';
type IdentityField = 'email' | 'password' | 'username' | 'first_name' | 'last_name' | 'birth_month' | 'birth_day' | 'birth_year';

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

const IDENTITY_FIELDS: Record<IdentityField, true> = {
  email: true,
  password: true,
  username: true,
  first_name: true,
  last_name: true,
  birth_month: true,
  birth_day: true,
  birth_year: true,
};

function isCapabilityPurpose(value: string): value is WelesCapabilityPurpose {
  return Object.hasOwn(CAPABILITY_PURPOSES, value);
}

function isCredentialFieldClass(value: string): value is CredentialFieldClass {
  return Object.hasOwn(CREDENTIAL_FIELD_CLASSES, value);
}

function isIdentityField(value: string): value is IdentityField {
  return Object.hasOwn(IDENTITY_FIELDS, value);
}

function stringArg(args: ToolArgs, key: string, fallback?: string): string {
  const value = args[key] === undefined ? fallback : args[key];
  if (typeof value !== 'string') throw new Error(`invalid ${key}: expected a string, received ${value === null ? 'null' : typeof value}`);
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

const TEXT = { type: 'string' };
const NUMBER = { type: 'number' };
const TARGET = { type: 'string', description: 'The element description or selector. For click, copy the complete observed CONTROLS entry, including every field and its optional [index]. Never supply an index alone or an object.' };
const CAPABILITY = {
  type: 'object',
  description: 'Copy the supplied opaque capability reference exactly. Never invent or alter its id, purpose, resource or target.',
  properties: { capability_id: TEXT, purpose: { type: 'string', enum: Object.keys(CAPABILITY_PURPOSES) }, resource: TEXT, target: { type: 'string', enum: ['weles'] } },
  required: ['capability_id', 'purpose', 'resource', 'target'],
  additionalProperties: false,
};

function browserTool(name: string, description: string, properties: Record<string, unknown>, required = Object.keys(properties)): FunctionTool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

export const BROWSER_TOOLS: readonly FunctionTool[] = [
  browserTool('click', 'Click an element. Prefer the complete current CONTROLS entry; preserve its tag and every reported field, including [index] when present. An explicit selector must match exactly one visible control and never falls back to an image guess. Otherwise describe the actual element in plain English.', { target: TARGET }),
  browserTool('fill', 'Fill a literal non-credential value. Credential values and environment placeholders are forbidden.', { target: TARGET, value: TEXT }),
  browserTool('fill_credential', 'Fill an authorized credential field using its supplied opaque capability. Describe the actual field, including its class. Never request or provide plaintext credentials.', {
    target: TARGET,
    field_class: { type: 'string', enum: Object.keys(CREDENTIAL_FIELD_CLASSES), description: 'Use the class bound by the supplied capability, not a class guessed from its value. Keep its resource unchanged.' },
    capability: CAPABILITY,
  }),
  browserTool('fill_identity', 'Fill one field from the current run-generated identity without exposing its value.', { target: TARGET, field: { type: 'string', enum: Object.keys(IDENTITY_FIELDS) } }),
  browserTool('store_credential', 'Store a newly issued token or API key directly in the task-authorized Skarbiec item. Never read or return its value.', { target: TARGET, field_class: { type: 'string', enum: ['token', 'api-key'] } }),
  browserTool('focus', 'Focus an input by name, type or placeholder, including shadow DOM.', { selector: TEXT }),
  browserTool('type_text', 'Type literal non-credential text after focusing. Environment placeholders are forbidden.', { value: TEXT }),
  browserTool('press_key', 'Press a keyboard key such as Enter, Tab or Escape.', { key: TEXT }, []),
  browserTool('navigate', 'Navigate to the supplied URL.', { url: TEXT }),
  browserTool('scroll', 'Scroll the actual page up or down by a number of pixels.', { direction: { type: 'string', enum: ['up', 'down'] }, amount: NUMBER }, []),
  browserTool('wait', 'Wait for the requested number of seconds.', { seconds: NUMBER }, []),
  browserTool('read', 'Answer a question using only the current screenshot. This cannot click, scroll, navigate or change page state.', { question: TEXT }),
  browserTool('select_option', 'Select a dropdown option, including date pickers.', { target: TARGET, value: TEXT }),
  browserTool('set_control', 'Set and verify an input, select or textarea by CSS selector in the page or an iframe. Use when normal fill, click or selection does not stick.', { selector: TEXT, value: {}, checked: { type: 'boolean' } }, ['selector']),
  browserTool('js_click', 'Last resort: click by selector or text only after click, set_control, and focus with press_key cannot reach the element.', { selector: TEXT, text: TEXT }, []),
  browserTool('solve_captcha', 'Solve a detected supported CAPTCHA and wait for automatic submission. Report failed or absent challenges honestly.', {}),
  browserTool('check_email', 'Poll for the authorized email verification code.', { email: TEXT, sender: TEXT }),
  browserTool('generate_identity', 'Generate an identity only for a task-authorized registration.', { platform: TEXT }, []),
  browserTool('check_sms', 'Request an SMS number for the authorized service and country.', { service: TEXT, country: TEXT }, ['service']),
  browserTool('poll_sms_code', 'Poll the existing authorized SMS order for its code.', {}),
  browserTool('save_account', 'Save a task-authorized newly registered account.', { platform: TEXT, username: TEXT, email: TEXT, password: TEXT, name: TEXT }, ['platform', 'username', 'email', 'password']),
  browserTool('done', 'Finish only when all goal conditions are confirmed by actual action results and the current page.', { value: {} }, []),
  browserTool('give_up', 'Stop when the goal cannot be completed; report the actual refusal and missing prerequisite.', { reason: TEXT }),
];

export async function dispatch(session: WSession, tool: string, args: ToolArgs): Promise<string> {
  const authorization = await enforceBrowserEvidenceToolPolicy(session, tool, args);
  if (authorization) return authorization.invoke();
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
    case 'fill_identity': {
      const field = stringArg(args, 'field');
      if (!isIdentityField(field)) throw new Error('invalid identity field');
      return session.fillIdentity(stringArg(args, 'target'), field);
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
      if (session.identity) return 'generated identity already available; use fill_identity for its fields';
      const platform = stringArg(args, 'platform', 'reddit');
      const id = await session.generateIdentity(platform);
      return `generated identity ready for fill_identity platform=${platform} username_hash=${id.username.length}:${id.username.slice(0, 2)}`;
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
