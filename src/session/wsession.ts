/**
 * WSession — unified high-level API for weles browser automation.
 * Every method uses shared modules. Agent tools map 1:1 to these methods.
 *
 * The class lives here; its larger responsibilities live in ./wsession/ —
 * session-request (what a caller asked for and where that request is named on
 * disk), browser-launch (bringing the browser up and adopting it),
 * run-provenance (what the run recorded about itself), network-observers (what
 * the wire showed) and page-actions (how we reach an element an ordinary human
 * click cannot).
 */

import { type BrowserContext, chromium } from 'playwright'; import { AsyncNewBrowser, type AsyncNewBrowserOptions } from '../async_api.js';
import { type Persona, generatePersona } from '../browser/persona.js';
import { SessionStore } from './store.js';
import { Capture } from '../capture/capture.js';
import { findClickTarget, askPage, checkPage, type ScreenshottablePage } from '../vision/analyze.js';
import { humanClick, humanClickLocator } from '../human/mouse.js';
import { humanType } from '../human/keyboard.js';
import { selectOption } from '../human/select.js';
import { waitCloudflare } from '../cloudflare/challenge.js';
import { solvePageCaptcha } from '../captcha/detect.js';
import { CaptchaSolver } from '../captcha/solver.js';
import { generateIdentity as genId, type Identity } from '../utils/identity/identity.js';
import { markSignupSuccess } from '../utils/email/domain.js';
import { snapshotSanitizedEnvironment } from '../utils/sanitize-env.js';
import { getNumber, pollCode, type SmsNumber } from '../utils/identity/sms.js';
import { writeFileSync, mkdirSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startInstrumentation } from './wsession-helpers/net_record.js';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { resolveProxy } from '../proxy/config.js';
import { seedHumanTiming } from '../utils/timing.js';
import { getEmailApiKey } from '../utils/credentials.js';
import { findCustomBrowser } from './find_browser.js';
import { costTracker } from '../utils/runtime/cost.js';
import { loadOperatorCdpConfig } from './operator-cdp.js';
import { enforceWelesServicePlacement } from './service-placement.js';

import { installAtoms } from './wsession_atoms.js';  // installAtoms() is invoked at file end after WSession is declared
import { runRecordingsDir, runRecordingsRoot } from './run-recordings.js';
import { wsClick, wsFill, wsFillCredential, wsFillIdentity } from './wsession-helpers/finalize.js';
import { isSkarbiecCredentialTask, wsAutoStoreCredential, wsStoreCredential } from './wsession-helpers/credential-store.js';
import type { CapabilityRef } from '../utils/capability.js';
import { assertNonCredentialInput } from '../utils/capability.js';
import { installBrowserEvidencePolicy } from '../agent/browser-evidence-policy.js';
import { type WSessionOptions } from './wsession/session-request.js';
import { adoptLaunchedBrowser, openSessionBrowser } from './wsession/browser-launch.js';
import { observeSessionNetwork } from './wsession/network-observers.js';
import { captureStepArtifacts, type StepArtifactFailure } from './wsession/run-provenance.js';
import { wsClickSelector, wsFocus, wsJsClick, wsScroll, wsSetControl } from './wsession/page-actions.js';

export type { WSessionOptions };

const asV = (p: any) => p as unknown as ScreenshottablePage;

export class WSession {
  readonly page: any;
  readonly ctx: BrowserContext;
  readonly label: string;
  private _cap: Capture;
  private _store: SessionStore;
  private _solver: CaptchaSolver;
  private _env: Record<string, string> = {};

  private _step = 0;
  captchaResponse: any = null;
  captchaFormData: any = null;
  authBlocked: string | null = null;
  captchaHeaders: Record<string, string> = {};
  captchaEndpoint: string = '';
  proxyConfig: { server: string; username?: string; password?: string; country?: string; exit_ip?: string; platform?: string } | undefined;
  personaConfig: Persona | undefined;
  // Identity assigned by WSession.start when opts.platform is set; eliminates
  // per-trajectory generateIdentity + field-rename boilerplate.
  identity: { firstName: string; lastName: string; username: string; email: string; password: string; birthMonth: string; birthDay: string; birthYear: string } | undefined;
  capturedResponses: Array<{ ts: number; method: string; url: string; status: number; headers: Record<string, string>; body: string }> = [];
  // Step screenshots / DOM dumps this run could not write, with the reason for
  // each. A step is never aborted by a missing artifact, so this list (and
  // step_artifact_failures.json beside the artifacts) is where the gap shows.
  stepArtifactFailures: StepArtifactFailure[] = [];
  private _smsOrder: SmsNumber | null = null;
  private _proxyBytes = 0;
  private _cdp: any = null;
  private _secureCredentialTask = false;
  private _storedCredentialReceipt: string | null = null;

  private constructor(ctx: BrowserContext, page: any, label: string, cap: Capture) {
    this.ctx = ctx; this.page = page; this.label = label; this._cap = cap;
    this._store = new SessionStore(); this._solver = new CaptchaSolver();
    this._secureCredentialTask = isSkarbiecCredentialTask();
    // Captcha/auth interception, the response ledger and the proxy byte
    // counter, subscribed synchronously so nothing loaded by the first
    // navigation is missed. See ./wsession/network-observers.ts.
    observeSessionNetwork(this, ctx, page);
  }

  async runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const n = String(this._step++).padStart(3, '0');
    const label = `${n}_${name.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}`;
    const url = (typeof this.page.url === 'function' ? this.page.url() : '') ?? '';
    const closed = this.page.isClosed?.() ?? false;
    const vs = this.page.viewportSize?.() ?? {};
    const retainStepArtifacts = !this._secureCredentialTask
      && process.env.WELES_NO_INSTRUMENT !== '1'
      && process.env.WELES_BROWSER_EVIDENCE_POLICY !== 'spis-browser-evidence.1';
    console.log(`[wsession] ${label} START url=${url.slice(0, 80)} closed=${closed} viewport=${vs.width}x${vs.height}`);
    if (retainStepArtifacts) await captureStepArtifacts(this, 'before', label);
    try {
      const result = await fn();
      if (this._secureCredentialTask) {
        const stored = await wsAutoStoreCredential(this);
        if (stored) this._storedCredentialReceipt = stored;
      }
      console.log(`[wsession] ${label} OK result=${String(result).slice(0, 100)}`);
      if (retainStepArtifacts) await captureStepArtifacts(this, 'after', label);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[wsession] ${label} ERROR ${message.slice(0, 300)}`);
      if (retainStepArtifacts) await captureStepArtifacts(this, 'error', label, error);
      throw error;
    }
  }

  takeStoredCredentialReceipt(): string | null {
    const receipt = this._storedCredentialReceipt;
    this._storedCredentialReceipt = null;
    return receipt;
  }

  static async start(opts: WSessionOptions = {}): Promise<WSession> {
    const launch = await openSessionBrowser(opts);
    const ws = new WSession(launch.ctx, launch.page, launch.label, launch.capture);
    if (launch.kind === 'launched') await adoptLaunchedBrowser(ws, launch);
    return ws;
  }

  async goto(url: string): Promise<string> {
    return this.runStep(`goto_${url.split('/').pop()?.slice(0,20)}`, async () => {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitCloudflare(asV(this.page));
      return `navigated to ${this.page.url?.() ?? url}`;
    });
  }

  // Method bodies extracted to ./wsession-helpers/finalize.ts and to
  // ./wsession/page-actions.ts to fit the 300-line per-file cap. wsClose has
  // the BD provider classifier fix.
  async click(target: string): Promise<string> { return wsClick(this, target); }
  async fill(target: string, value: string): Promise<string> { return wsFill(this, target, value); }
  async fillCredential(
    target: string,
    fieldClass: 'password' | 'email' | 'username' | 'token' | 'api-key',
    capability: CapabilityRef,
  ): Promise<string> { return wsFillCredential(this, target, fieldClass, capability); }
  async fillIdentity(
    target: string,
    field: 'email' | 'password' | 'username' | 'first_name' | 'last_name' | 'birth_month' | 'birth_day' | 'birth_year',
  ): Promise<string> {
    const identity = this.identity;
    if (!identity) throw new Error('generated identity is unavailable');
    switch (field) {
      case 'email': return wsFillIdentity(this, target, field, identity.email);
      case 'password': return wsFillIdentity(this, target, field, identity.password);
      case 'username': return wsFillIdentity(this, target, field, identity.username);
      case 'first_name': return wsFillIdentity(this, target, field, identity.firstName);
      case 'last_name': return wsFillIdentity(this, target, field, identity.lastName);
      case 'birth_month': return wsFillIdentity(this, target, field, identity.birthMonth);
      case 'birth_day': return wsFillIdentity(this, target, field, identity.birthDay);
      case 'birth_year': return wsFillIdentity(this, target, field, identity.birthYear);
    }
  }
  async storeCredential(target: string, fieldClass: 'token' | 'api-key'): Promise<string> {
    return wsStoreCredential(this, target, fieldClass);
  }

  async focus(selector: string): Promise<string> { return wsFocus(this, selector); }
  async jsClick(selector?: string, text?: string): Promise<string> { return wsJsClick(this, selector, text); }
  async clickSelector(selector: string): Promise<string> { return wsClickSelector(this, selector); }
  async type(value: string): Promise<string> {
    const literal = assertNonCredentialInput(value);
    return this.runStep('type', async () => { await humanType(this.page, literal); return 'typed'; });
  }
  async press(key: string): Promise<string> { return this.runStep(`press_${key}`, async () => { await this.page.keyboard.press(key); return `pressed ${key}`; }); }
  async select(target: string, value: string): Promise<string> { return this.runStep(`select_${target}_${value}`, async () => { const result = await selectOption(this.page, target, this.resolveEnv(value)); return result ? `selected: ${result}` : 'no-select-found'; }); }
  async setControl(selector: string, value?: unknown, checked?: unknown): Promise<string> { return wsSetControl(this, selector, value, checked); }
  async scroll(direction: string, amount?: number): Promise<string> { return wsScroll(this, direction, amount); }

  async wait(seconds: number): Promise<string> { await new Promise(r => setTimeout(r, seconds * 1000)); return `waited ${seconds}s`; }  // allow-raw-playwright: review — context-dependent timer
  async read(question: string): Promise<string> { return await askPage(asV(this.page), question) ?? 'NONE'; }
  async solveCaptcha(): Promise<string> {
    return this.runStep('solveCaptcha', async () => {
      const result = await solvePageCaptcha(this.page, this._solver, this);
      if (result === null) return 'no supported captcha detected';
      return result ? 'captcha solved' : 'captcha failed';
    });
  }

  async checkEmail(email: string, sender: string): Promise<string> { const { wsCheckEmail } = await import('./wsession-helpers/finalize.js'); return wsCheckEmail(this, email, sender); }
  async checkSms(service: string, country = 'UK'): Promise<string> { this._smsOrder = await getNumber(service, country); if (!this._smsOrder) return 'error: no SMS number available'; this._env[`${service.toUpperCase()}_NEW_PHONE`] = this._smsOrder.phone; return `phone: ${this._smsOrder.phone}`; }
  async pollSmsCode(): Promise<string> { if (!this._smsOrder) return 'error: no SMS order'; return (await pollCode(this._smsOrder.orderId, this._smsOrder.provider)) ?? 'no code received'; }

  async generateIdentity(platform: string): Promise<Identity> {
    const id = await genId(platform);
    const k = platform.toUpperCase();
    this._env[`${k}_NEW_USERNAME`] = id.username;
    this._env[`${k}_NEW_EMAIL`] = id.email;
    this._env[`${k}_NEW_PASSWORD`] = id.password;
    this._env[`${k}_NEW_FIRSTNAME`] = id.firstName;
    this._env[`${k}_NEW_LASTNAME`] = id.lastName;
    this._env[`${k}_NEW_BIRTHMONTH`] = id.birthMonth;
    this._env[`${k}_NEW_BIRTHDAY`] = id.birthDay;
    this._env[`${k}_NEW_BIRTHYEAR`] = id.birthYear;
    return id;
  }

  async saveCookies(): Promise<string> { if (!this.label) return 'no label'; await this._store.capturePlaywright(this.ctx, this.label); return 'cookies saved'; }
  async needsLogin(): Promise<boolean> { return await checkPage(asV(this.page), 'Is this a login page?'); }
  async screenshot(label: string): Promise<string> { return await this._cap.screenshot(this.page, label); }

  async saveAccount(platform: string, data: { username: string; email: string; password: string; name?: string; status?: string }): Promise<string> { const { wsSaveAccount } = await import('./wsession-helpers/finalize.js'); return wsSaveAccount(this, platform, data); }
  async close(): Promise<void> { const { wsClose } = await import('./wsession-helpers/finalize.js'); return wsClose(this); }

  resolveEnv(v: string): string {
    const out = v.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, k) => this._env[k] ?? process.env[k] ?? `$${k}`);
    if (/\$\{?[A-Z_][A-Z0-9_]*_NEW_[A-Z0-9_]*\}?/.test(out)) throw new Error('unresolved generated identity placeholder');
    return out;
  }

  /** Derive a stable proxy signature for cookie-jar binding (mirrors cookie-freshness.mjs). */
  private _proxySignature(): string | null {
    const cfg = this.proxyConfig;
    if (!cfg) return null;
    if (typeof cfg === 'object' && (cfg as any).host) {
      const port = (cfg as any).port ? String((cfg as any).port) : '';
      return `${(cfg as any).host}:${port}`.replace(/:$/, '');
    }
    if (typeof cfg === 'string') {
      const u = new URL(cfg);
      return `${u.hostname}:${u.port || ''}`.replace(/:$/, '');
    }
    return null;
  }

  /** Derive a stable persona signature for cookie-jar binding (mirrors cookie-freshness.mjs). */
  private _personaSignature(): string | null {
    const p = this.personaConfig as any;
    if (!p) return null;
    if (p.canvasSeed != null) return `cs:${p.canvasSeed}`;
    const s = `${p.userAgentOs ?? ''}|${p.gpu?.renderer ?? ''}|${p.timezone ?? ''}|${p.language ?? ''}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return `h:${h}`;
  }
}

installAtoms(WSession);
