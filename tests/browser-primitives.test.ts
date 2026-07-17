import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { selectOption } from '../src/human/select.js';
import { WSession } from '../src/session/wsession.js';
import { execute } from '../src/agent/loop.js';
import { dispatch } from '../src/agent/tools.js';

class FakeEvent {
  type: string;
  bubbles: boolean;

  constructor(type: string, init?: { bubbles?: boolean }) {
    this.type = type;
    this.bubbles = !!init?.bubbles;
  }
}

class FakeElement {
  tagName: string;
  textContent: string;
  innerText: string;
  private rawValue = '';
  type: string;
  name: string;
  href: string;
  checked?: boolean;
  selectedOptions?: Array<{ text: string }>;
  options?: Array<{ text: string; value: string }>;
  selectedIndex = -1;
  events: string[] = [];
  shadowRoot: null = null;
  offsetParent = {};
  private attrs: Record<string, string>;

  get value(): string {
    return this.rawValue;
  }

  set value(value: string) {
    this.rawValue = value;
    if (!this.options) return;
    const selectedIndex = this.options.findIndex(option => option.value === value || option.text === value);
    if (selectedIndex < 0) return;
    this.selectedIndex = selectedIndex;
    this.selectedOptions = [{ text: this.options[selectedIndex].text }];
  }

  constructor(tag: string, opts: {
    text?: string;
    value?: string;
    type?: string;
    name?: string;
    href?: string;
    checked?: boolean;
    attrs?: Record<string, string>;
    selectedText?: string;
    options?: string[];
  } = {}) {
    this.tagName = tag.toUpperCase();
    this.textContent = opts.text ?? '';
    this.innerText = opts.text ?? '';
    this.rawValue = opts.value ?? '';
    this.type = opts.type ?? '';
    this.name = opts.name ?? '';
    this.href = opts.href ?? '';
    this.checked = opts.checked;
    this.attrs = opts.attrs ?? {};
    if (opts.selectedText) this.selectedOptions = [{ text: opts.selectedText }];
    if (opts.options) this.options = opts.options.map(text => ({ text, value: text }));
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  removeAttribute(name: string): void {
    delete this.attrs[name];
  }

  dispatchEvent(event: FakeEvent): boolean {
    this.events.push(event.type);
    return true;
  }

  click(): void {
    this.events.push('click');
  }

  getBoundingClientRect(): { width: number; height: number; x: number; y: number } {
    return { width: 10, height: 10, x: 0, y: 0 };
  }

  scrollIntoView(): void {}

  querySelectorAll(): FakeElement[] {
    return [];
  }
}

class FakeInputElement extends FakeElement {}
class FakeTextAreaElement extends FakeElement {}
class FakeSelectElement extends FakeElement {}


function makeDocument(elements: FakeElement[], opts: { title?: string; text?: string } = {}) {
  const byId = new Map<string, FakeElement>();
  for (const el of elements) {
    const id = el.getAttribute('id');
    if (id) byId.set(id, el);
  }
  return {
    title: opts.title ?? '',
    body: { innerText: opts.text ?? '' },
    getElementById(id: string): FakeElement | null {
      return byId.get(id) ?? null;
    },
    querySelector(selector: string): FakeElement | null {
      return this.querySelectorAll(selector)[0] ?? null;
    },

    querySelectorAll(selector: string): FakeElement[] {
      if (selector === '*') return elements;
      if (selector === 'select') return elements.filter(el => el.tagName === 'SELECT');
      if (selector.includes('input') || selector.includes('textarea') || selector.includes('select') || selector.includes('button') || selector.includes('label') || selector.includes('[role=')) {
        return elements.filter(el => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          return selector.includes(tag) || (!!role && selector.includes(`[role="${role}"]`));
        });
      }
      return [];
    },
  };
}

function evaluateWithDocument(source: string | (() => unknown), document: ReturnType<typeof makeDocument>, arg?: unknown): unknown {
  const body = typeof source === 'function'
    ? `return (${source.toString()})(arg);`
    : `return (${source});`;
  return new Function('document', 'Event', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'arg', body)(document, FakeEvent, FakeInputElement, FakeTextAreaElement, FakeSelectElement, arg);
}

function frameWithDocument(document: ReturnType<typeof makeDocument>) {
  return {
    evaluate: vi.fn(async (source: string | (() => unknown), arg?: unknown) => evaluateWithDocument(source, document, arg)),
    locator: vi.fn(() => ({ first: () => ({ count: vi.fn(async () => 0) }) })),
    getByText: vi.fn(() => ({
      first: () => ({
        count: vi.fn(async () => 0),
        isVisible: vi.fn(async () => false),
      }),
    })),
    name: vi.fn(() => 'child'),
    url: vi.fn(() => 'https://frame.example.test'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.BRAMA_URL;
  delete process.env.WISENT_APP_AGENT_ID;
  delete process.env.WISENT_APP_AGENT_AUTH_SECRET;
  delete process.env.WELES_RUN_ID;
});

describe('browser frame primitives', () => {
  it('dispatch routes set_control selector value and checked to the session primitive', async () => {
    const setControl = vi.fn(async () => 'set-control-ok');
    const session = { setControl } as unknown as WSession;

    await expect(dispatch(session, 'set_control', {
      selector: 'input[name="terms"]',
      value: 'raw-control-value',
      checked: false,
    })).resolves.toBe('set-control-ok');

    expect(setControl).toHaveBeenCalledWith('input[name="terms"]', 'raw-control-value', false);
  });

  it('selectOption selects a native option inside a child frame when the main document has no match', async () => {
    const mainFrame = frameWithDocument(makeDocument([]));
    const select = new FakeElement('select', { options: ['Other', 'Semantic Scholar'] });
    const childFrame = frameWithDocument(makeDocument([select]));
    const page = {
      mainFrame: vi.fn(() => mainFrame),
      frames: vi.fn(() => [mainFrame, childFrame]),
    };

    await expect(selectOption(page, 'service', 'semantic scholar')).resolves.toBe('Semantic Scholar');

    expect(select.selectedIndex).toBe(1);
    expect(select.events).toEqual(['change']);
    expect(mainFrame.evaluate).toHaveBeenCalledOnce();
    expect(childFrame.evaluate).toHaveBeenCalledOnce();
  });

  it('jsClick clicks labeled radio text inside a child frame and emits input/change for the associated control', async () => {
    const radio = new FakeInputElement('input', {
      type: 'radio',
      name: 'hubspotChoice',
      checked: false,
      attrs: { id: 'hubspot-radio' },
    });
    const label = new FakeElement('label', {
      text: 'Use HubSpot embedded form',
      attrs: { for: 'hubspot-radio' },
    });
    const mainFrame = frameWithDocument(makeDocument([]));
    const childFrame = frameWithDocument(makeDocument([label, radio]));
    const page = {
      evaluate: vi.fn(async () => null),
      mainFrame: vi.fn(() => mainFrame),
      frames: vi.fn(() => [mainFrame, childFrame]),
    };
    const session = {
      page,
      runStep: vi.fn(async (_name: string, fn: () => Promise<string>) => fn()),
    };

    const result = await WSession.prototype.jsClick.call(session as unknown as WSession, undefined, 'HubSpot embedded form');

    expect(result).toContain('clicked-frame-untrusted');
    expect(radio.checked).toBe(true);
    expect(radio.events).toEqual(['click', 'input', 'change']);
    expect(label.events).toEqual(['click']);
  });

  it('setControl selects a native option inside a child frame and returns verified text without raw value', async () => {
    const rawOptionValue = 'enterprise-secret-code';
    const select = new FakeElement('select', { name: 'plan', options: ['Basic Plan', 'Enterprise Plan'] });
    select.options = [
      { text: 'Basic Plan', value: 'basic' },
      { text: 'Enterprise Plan', value: rawOptionValue },
    ];
    const validation = new FakeElement('div', {
      text: 'Choose a plan before continuing',
      attrs: { role: 'alert' },
    });
    const mainFrame = frameWithDocument(makeDocument([]));
    const childFrame = frameWithDocument(makeDocument([select, validation]));
    const page = {
      mainFrame: vi.fn(() => mainFrame),
      frames: vi.fn(() => [mainFrame, childFrame]),
    };
    const session = {
      page,
      resolveEnv: vi.fn((value: string) => value),
      runStep: vi.fn(async (_name: string, fn: () => Promise<string>) => fn()),
    };

    const result = await WSession.prototype.setControl.call(session as unknown as WSession, 'select', rawOptionValue);
    const state = JSON.parse(result.replace(/^set_control /, '')) as {
      tag: string;
      name: string;
      valuePresent: boolean;
      valueLength: number;
      selectedText: string;
      validation: string[];
    };

    expect(state).toMatchObject({
      tag: 'select',
      name: 'plan',
      valuePresent: true,
      valueLength: rawOptionValue.length,
      selectedText: 'Enterprise Plan',
      validation: ['Choose a plan before continuing'],
    });
    expect(result).not.toContain(rawOptionValue);
    expect(select.value).toBe(rawOptionValue);
    expect(select.events).toEqual(['input', 'change', 'blur']);
    expect(mainFrame.evaluate).toHaveBeenCalledOnce();
    expect(childFrame.evaluate).toHaveBeenCalledOnce();
  });

  it('setControl checks a child-frame checkbox and returns verified checked state without raw value', async () => {
    const rawCheckboxValue = 'agreement-secret-value';
    const checkbox = new FakeInputElement('input', {
      type: 'checkbox',
      name: 'terms',
      value: rawCheckboxValue,
      checked: false,
    });
    const validation = new FakeElement('div', {
      text: 'Accept the terms to continue',
      attrs: { role: 'alert' },
    });
    const mainFrame = frameWithDocument(makeDocument([]));
    const childFrame = frameWithDocument(makeDocument([checkbox, validation]));
    const page = {
      mainFrame: vi.fn(() => mainFrame),
      frames: vi.fn(() => [mainFrame, childFrame]),
    };
    const session = {
      page,
      resolveEnv: vi.fn((value: string) => value),
      runStep: vi.fn(async (_name: string, fn: () => Promise<string>) => fn()),
    };

    const result = await WSession.prototype.setControl.call(session as unknown as WSession, 'input', undefined, true);
    const state = JSON.parse(result.replace(/^set_control /, '')) as {
      tag: string;
      type: string;
      name: string;
      valuePresent: boolean;
      valueLength: number;
      checked: boolean;
      validation: string[];
    };

    expect(state).toMatchObject({
      tag: 'input',
      type: 'checkbox',
      name: 'terms',
      valuePresent: true,
      valueLength: rawCheckboxValue.length,
      checked: true,
      validation: ['Accept the terms to continue'],
    });
    expect(result).not.toContain(rawCheckboxValue);
    expect(checkbox.checked).toBe(true);
    expect(checkbox.events).toEqual(['input', 'change', 'blur']);
    expect(mainFrame.evaluate).toHaveBeenCalledOnce();
    expect(childFrame.evaluate).toHaveBeenCalledOnce();
  });

  it('execute page observation redacts sensitive values while preserving checked state and selected option text', async () => {
    process.env.BRAMA_URL = 'https://router.example.test';
    process.env.WISENT_APP_AGENT_ID = 'unit-test-agent';
    process.env.WISENT_APP_AGENT_AUTH_SECRET = 'unit-test-secret';
    process.env.WELES_RUN_ID = `browser-primitives-${Date.now()}`;

    const rawEmail = 'person@example.com';
    const rawPassword = 'P@ssw0rd!';
    const rawKey = 'sk-live-secret-key';
    const rawCaptcha = 'captcha-token-123';
    const selectedPlan = 'Institutional Plan';
    const controls = [
      new FakeInputElement('input', { type: 'email', name: 'email', value: rawEmail, attrs: { 'aria-label': 'Email' } }),
      new FakeInputElement('input', { type: 'password', name: 'password', value: rawPassword, attrs: { 'aria-label': 'Password' } }),
      new FakeInputElement('input', { type: 'text', name: 'api_key', value: rawKey, attrs: { 'aria-label': 'API key' } }),
      new FakeInputElement('input', { type: 'text', name: 'captcha', value: rawCaptcha, attrs: { 'aria-label': 'Captcha' } }),
      new FakeInputElement('input', { type: 'checkbox', name: 'agree', checked: true, attrs: { 'aria-label': 'Agree to terms' } }),
      new FakeElement('select', { name: 'plan', value: 'enterprise', selectedText: selectedPlan, attrs: { 'aria-label': 'Plan' } }),
    ];
    const mainFrame = frameWithDocument(makeDocument(controls, { title: 'Settings', text: 'Configure Semantic Scholar access' }));
    const page = {
      url: vi.fn(() => 'https://example.test/settings'),
      screenshot: vi.fn(async () => Buffer.from('png')),
      mainFrame: vi.fn(() => mainFrame),
      frames: vi.fn(() => [mainFrame]),
      context: vi.fn<() => { pages: () => object[] }>(() => ({ pages: () => [] })),
      isClosed: vi.fn(() => false),
      waitForLoadState: vi.fn(async () => undefined),
    };
    page.context.mockReturnValue({ pages: () => [page] });
    const prompts: string[] = [];

    const result = await execute({ page, label: '', resolveEnv: (value: string) => value } as unknown as WSession, 'inspect the page', {
      modelDecision: async (prompt) => {
        prompts.push(prompt);
        return {
          raw: '{"tool":"done","args":{"value":"ok"}}',
          model: 'unit-test-model',
          routerUrl: 'https://router.example.test',
        };
      },
    });

    expect(result.value).toBe('ok');
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt).toContain('checked=true');
    expect(prompt).toContain(`value=${selectedPlan}`);
    expect(prompt).toContain('value=[set len=18]');
    expect(prompt).not.toContain(rawEmail);
    expect(prompt).not.toContain(rawPassword);
    expect(prompt).not.toContain(rawKey);
    expect(prompt).not.toContain(rawCaptcha);

    rmSync(join(process.cwd(), 'recordings', process.env.WELES_RUN_ID), { recursive: true, force: true });
  });
});
