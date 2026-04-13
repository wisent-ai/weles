/**
 * Task runner, trajectory cache, and registry.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CDPWeles } from '../browser/api.js';
import { SessionStore } from '../session/store.js';
import { execute, AgentFailure, type ToolCall, type LoopResult } from './loop.js';

// ---------------------------------------------------------------------------
// Trajectory cache
// ---------------------------------------------------------------------------

function trajDir(): string {
  const dir = join(process.env.WELES_CACHE_DIR ?? join(homedir(), '.weles'), 'trajectories');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class Trajectory {
  service: string;
  toolCalls: Array<{ tool: string; args: Record<string, any> }>;
  lastValue?: any;
  lastSuccess?: string;

  constructor(service: string, toolCalls: any[], lastValue?: any) {
    this.service = service;
    this.toolCalls = toolCalls;
    this.lastValue = lastValue;
    this.lastSuccess = new Date().toISOString();
  }

  static load(service: string): Trajectory | null {
    const path = join(trajDir(), `${service}.json`);
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return Object.assign(new Trajectory(data.service, data.toolCalls), data);
    } catch { return null; }
  }

  save(): void {
    const path = join(trajDir(), `${this.service}.json`);
    writeFileSync(path, JSON.stringify(this, null, 2));
  }

  static invalidate(service: string): void {
    const path = join(trajDir(), `${service}.json`);
    try { unlinkSync(path); } catch { /* skip */ }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface TaskConfig {
  url: string;
  what: string;
  loginMethod: 'google_sso' | 'email_password' | 'none';
  navUrl?: string;
  captchaSitekey?: string;
  requiresTarget?: boolean;
  noProxy?: boolean;
}

export const REGISTRY: Record<string, TaskConfig> = {
  // Service dashboards
  'oxylabs_balance': { url: 'https://dashboard.oxylabs.io', navUrl: 'https://dashboard.oxylabs.io/en/overview/MP/statistics', what: 'the traffic usage shown as X GB / Y GB', loginMethod: 'google_sso', noProxy: true },
  'brightdata_balance': { url: 'https://brightdata.com/cp', what: 'the current account credit balance in USD', loginMethod: 'google_sso', noProxy: true },
  'capmonster_cloud_balance': { url: 'https://dash.capmonster.cloud', what: 'the current account balance in USD', loginMethod: 'google_sso', noProxy: true },
  'anticaptcha_balance': { url: 'https://anti-captcha.com/clients', what: 'the current account balance in USD', loginMethod: 'google_sso', noProxy: true },
  'packetstream_balance': { url: 'https://app.packetstream.io', what: 'the current account balance in USD', loginMethod: 'email_password', noProxy: true },
  'capsolver_balance': { url: 'https://dashboard.capsolver.com', what: 'the current account balance in USD', loginMethod: 'email_password', noProxy: true },
  'twocaptcha_balance': { url: 'https://2captcha.com', what: 'the current account balance in USD', loginMethod: 'email_password', noProxy: true },
  'pingproxies_balance': { url: 'https://dashboard.pingproxies.com', what: 'the current account balance or remaining traffic', loginMethod: 'email_password', noProxy: true },
  // Registration
  'reddit_register': { url: 'https://www.reddit.com/register', what: 'the newly created username', loginMethod: 'none', captchaSitekey: '6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ' },
  'instagram_register': { url: 'https://www.instagram.com/accounts/emailsignup/', what: 'the newly created username', loginMethod: 'none' },
  'twitter_register': { url: 'https://x.com/i/flow/signup', what: 'the newly created username', loginMethod: 'none' },
  'tiktok_register': { url: 'https://www.tiktok.com/signup', what: 'the newly created username', loginMethod: 'none' },
  'discord_register': { url: 'https://discord.com/register', what: 'the newly created username', loginMethod: 'none' },
  // Login
  'reddit_login': { url: 'https://www.reddit.com/login', what: 'confirmation that login succeeded', loginMethod: 'email_password' },
  'instagram_login': { url: 'https://www.instagram.com/accounts/login/', what: 'confirmation that login succeeded', loginMethod: 'email_password' },
  'twitter_login': { url: 'https://x.com/login', what: 'confirmation that login succeeded', loginMethod: 'email_password' },
  'tiktok_login': { url: 'https://www.tiktok.com/login', what: 'confirmation that login succeeded', loginMethod: 'email_password' },
  'github_login': { url: 'https://github.com/login', what: 'confirmation that login succeeded', loginMethod: 'email_password' },
  'discord_login': { url: 'https://discord.com/login', what: 'confirmation that login succeeded', loginMethod: 'email_password' },
  'linkedin_login': { url: 'https://www.linkedin.com/login', what: 'confirmation that login succeeded', loginMethod: 'email_password' },
  // Social actions
  'reddit_upvote': { url: 'https://www.reddit.com', what: 'confirmation that the upvote was applied', loginMethod: 'email_password', requiresTarget: true },
  'reddit_comment': { url: 'https://www.reddit.com', what: 'confirmation that the comment was posted', loginMethod: 'email_password', requiresTarget: true },
  'instagram_follow': { url: 'https://www.instagram.com', what: 'confirmation that the follow was applied', loginMethod: 'email_password', requiresTarget: true },
  'instagram_like': { url: 'https://www.instagram.com', what: 'confirmation that the like was applied', loginMethod: 'email_password', requiresTarget: true },
  'twitter_follow': { url: 'https://x.com', what: 'confirmation that the follow was applied', loginMethod: 'email_password', requiresTarget: true },
  'twitter_like': { url: 'https://x.com', what: 'confirmation that the like was applied', loginMethod: 'email_password', requiresTarget: true },
  'twitter_dm': { url: 'https://x.com/messages', what: 'confirmation that the DM was sent', loginMethod: 'email_password', requiresTarget: true },
  'tiktok_follow': { url: 'https://www.tiktok.com', what: 'confirmation that the follow was applied', loginMethod: 'email_password', requiresTarget: true },
  'tiktok_like': { url: 'https://www.tiktok.com', what: 'confirmation that the like was applied', loginMethod: 'email_password', requiresTarget: true },
  'github_star_repo': { url: 'https://github.com', what: 'confirmation that the repo was starred', loginMethod: 'email_password', requiresTarget: true },
  'github_follow': { url: 'https://github.com', what: 'confirmation that the follow was applied', loginMethod: 'email_password', requiresTarget: true },
};

// ---------------------------------------------------------------------------
// Goal builder
// ---------------------------------------------------------------------------

function buildGoal(config: TaskConfig, usernameEnv: string, passwordEnv: string, target?: string): string {
  const nav = config.navUrl ? ` After login, navigate() to ${config.navUrl}.` : '';
  if (config.loginMethod === 'none') {
    const [service] = Object.entries(REGISTRY).find(([, v]) => v === config) ?? ['unknown'];
    const platform = service.split('_')[0].toUpperCase();
    const cap = config.captchaSitekey ? ` solve_captcha(sitekey='${config.captchaSitekey}') BEFORE every Continue.` : '';
    return `Open ${config.url}. Create account: generate_identity(platform='${service.split('_')[0]}').${cap} focus(selector='email'), type_text(value=$${platform}_NEW_EMAIL). check_email for verification codes. done(value=username) when complete.`;
  }
  const sso = config.loginMethod === 'google_sso' ? " Use 'Sign in with Google'." : '';
  const tgt = target ? ` Target: ${target}.` : '';
  return `Open ${config.url}. Log in: $${usernameEnv} / $${passwordEnv}.${sso}${nav}${tgt} Read ${config.what}. done() with value.`;
}

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

async function loadCredentials(service: string, usernameEnv: string, passwordEnv: string): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  // Try service_credentials
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/service_credentials?id=eq.${service}&select=login_email,login_password`, { headers });
    const rows = await res.json() as any[];
    if (rows?.[0]?.login_email) {
      process.env[usernameEnv] = rows[0].login_email;
      if (rows[0].login_password) process.env[passwordEnv] = rows[0].login_password;
      return;
    }
  } catch { /* skip */ }
  // Try social_accounts
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/social_accounts?platform=eq.${service}&status=eq.active&select=username,metadata&limit=1&order=created_at.desc`, { headers });
    const rows = await res.json() as any[];
    if (rows?.[0]) {
      const m = rows[0].metadata ?? {};
      process.env[usernameEnv] = rows[0].username ?? '';
      if (m.password) process.env[passwordEnv] = m.password;
    }
  } catch { /* skip */ }
}

// ---------------------------------------------------------------------------
// Task runner
// ---------------------------------------------------------------------------

export async function runTask(key: string, target?: string): Promise<any> {
  const config = REGISTRY[key];
  if (!config) throw new Error(`Unknown task: ${key}. Available: ${Object.keys(REGISTRY).join(', ')}`);
  if (config.requiresTarget && !target) throw new Error(`Task ${key} requires a target`);

  const service = key.split('_')[0];
  const usernameEnv = `${service.toUpperCase()}_EMAIL`;
  const passwordEnv = `${service.toUpperCase()}_PASSWORD`;

  await loadCredentials(service, usernameEnv, passwordEnv);

  const goal = buildGoal(config, usernameEnv, passwordEnv, target);
  const traj = Trajectory.load(key);
  const replay = traj?.toolCalls as ToolCall[] | undefined;
  const sessions = new SessionStore();

  // Auto-detect proxy from env vars (Oxylabs > PacketStream > Pingproxies)
  let proxy: string | undefined;
  for (const [uEnv, pEnv, host, port, fmt] of [
    ['OXYLABS_USERNAME', 'OXYLABS_PASSWORD', 'pr.oxylabs.io', '7777', (u: string, p: string) => `http://customer-${u}-cc-US:${p}@pr.oxylabs.io:7777`],
    ['PACKETSTREAM_USERNAME', 'PACKETSTREAM_PASSWORD', 'proxy.packetstream.io', '31112', (u: string, p: string) => `http://${u}:${p}_country-US@proxy.packetstream.io:31112`],
    ['PINGPROXIES_USERNAME', 'PINGPROXIES_PASSWORD', 'residential.pingproxies.com', '8000', (u: string, p: string) => `http://${u}_c_us:${p}@residential.pingproxies.com:8000`],
  ] as const) {
    const u = process.env[uEnv], p = process.env[pEnv];
    if (u && p) { proxy = (fmt as any)(u, p); break; }
  }

  const useProxy = config.noProxy ? undefined : proxy;
  console.log(`[task] ${key}: launching browser (proxy=${useProxy ? 'yes' : 'none'})...`);
  const weles = await CDPWeles.launch({
    headless: false,
    recordVideo: true,
    chromiumPath: process.env.CHROMIUM_PATH,
    proxy: useProxy,
  });
  console.log(`[task] ${key}: browser launched`);

  try {
    const ctx = weles.context;
    const page = await ctx.newPage();
    console.log(`[task] ${key}: page created`);

    // Inject saved cookies
    await sessions.inject(ctx as any, key);

    console.log(`[task] ${key}: navigating to ${config.url}`);
    try {
      await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    } catch (navErr: any) {
      console.log(`[task] ${key}: initial navigation error (continuing): ${navErr.message}`);
    }
    console.log(`[task] ${key}: navigated, url=${page.url}`);

    const result = await execute(page, goal, {
      envHints: { username_env: usernameEnv, password_env: passwordEnv },
      replay,
      context: ctx,
    });

    // Save trajectory on success
    new Trajectory(key, result.history.map(c => ({ tool: c.tool, args: c.args })), result.value).save();

    // Save cookies
    await sessions.capture(ctx as any, key);

    return result.value;
  } catch (e: any) {
    console.log(`[task] ${key}: error: ${e.message}`);
    if (e.stack) console.log(e.stack.split('\n').slice(0, 5).join('\n'));
    if (e instanceof AgentFailure) {
      Trajectory.invalidate(key);
    }
    return null;
  } finally {
    await weles.close();
  }
}
