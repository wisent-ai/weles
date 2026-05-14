/**
 * Chrome cookie import (macOS).
 *
 * Discovers the users Chrome profile dirs, finds the profile signed in
 * under a given Google email, decrypts its cookies via the Chrome Safe
 * Storage keychain password, and emits rows in Playwright cookie shape
 * so a WSession context can inject exactly one Google identity instead
 * of the merged soup every profile on the box would produce.
 *
 * Scope: v10 and v11 envelopes, which cover every pre-Chrome-127 cookie.
 * v20 app-bound envelopes are skipped; the count is returned so callers
 * can decide how to surface it.
 */
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import {
  readFileSync, copyFileSync, readdirSync, statSync, existsSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';

const CHROME_ROOT = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const GOOGLE_HOST_PATTERNS = ['%google.com%', '%youtube.com%', '%googleusercontent.com%'];
const SQL_SEP = '\x1f';

export interface ChromeProfile {
  path: string;
  name: string;
  email: string | null;
  emails: string[];
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
}

export interface ExportResult {
  cookies: PlaywrightCookie[];
  v20Skipped: number;
}

function safeStorageKey(): Buffer {
  const pw = execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', 'Chrome Safe Storage', '-w'],
  ).toString().trim();
  return pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
}

function getProfileEmails(profileDir: string): string[] {
  const prefs = join(profileDir, 'Preferences');
  if (!existsSync(prefs)) return [];
  try {
    const raw = readFileSync(prefs, 'utf8');
    const matches = [...raw.matchAll(/"email"\s*:\s*"([^"]+)"/g)];
    return [...new Set(matches.map(m => m[1]).filter(e => e.includes('@')))];
  } catch {
    return [];
  }
}

export function listProfiles(): ChromeProfile[] {
  if (!existsSync(CHROME_ROOT)) return [];
  const out: ChromeProfile[] = [];
  for (const entry of readdirSync(CHROME_ROOT)) {
    const p = join(CHROME_ROOT, entry);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(p, 'Preferences'))) continue;
    const emails = getProfileEmails(p);
    out.push({ path: p, name: entry, email: emails[0] ?? null, emails });
  }
  return out;
}

export function findProfileByEmail(email: string): ChromeProfile | null {
  const target = email.toLowerCase();
  for (const p of listProfiles()) {
    if (p.emails.some(e => e.toLowerCase() === target)) return p;
  }
  return null;
}

function unpadPkcs7(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  const n = buf[buf.length - 1];
  if (n > 0 && n <= 16) {
    let valid = true;
    for (let i = buf.length - n; i < buf.length; i++) {
      if (buf[i] !== n) { valid = false; break; }
    }
    if (valid) return buf.subarray(0, buf.length - n);
  }
  return buf;
}

function decryptV10(blob: Buffer, key: Buffer): string {
  const ct = blob.subarray(3);
  const iv = Buffer.alloc(16, 0x20);
  const d = createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  return unpadPkcs7(Buffer.concat([d.update(ct), d.final()])).toString('utf8');
}

function sameSiteMap(n: number): 'Lax' | 'Strict' | 'None' {
  return n === 1 ? 'Strict' : n === 2 ? 'None' : 'Lax';
}

function querySqlite(db: string, sql: string): string {
  return execFileSync(
    '/usr/bin/sqlite3',
    ['-separator', SQL_SEP, db, sql],
  ).toString();
}

export function exportCookies(
  profile: ChromeProfile,
  hostPatterns: string[],
): ExportResult {
  const key = safeStorageKey();
  let src = join(profile.path, 'Cookies');
  if (!existsSync(src)) src = join(profile.path, 'Network', 'Cookies');
  if (!existsSync(src)) return { cookies: [], v20Skipped: 0 };

  const tmp = join(tmpdir(), `weles_chrome_cookies_${profile.name.replace(/[^A-Za-z0-9]/g, '_')}.db`);
  copyFileSync(src, tmp);

  const esc = (p: string) => p.replace(/'/g, "''");
  const where = hostPatterns.map(p => `host_key LIKE '${esc(p)}'`).join(' OR ');
  const sql =
    `SELECT host_key, name, value, quote(encrypted_value), path, ` +
    `expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE ${where};`;

  try {
    const raw = querySqlite(tmp, sql);
    const cookies: PlaywrightCookie[] = [];
    let v20Skipped = 0;

    for (const line of raw.split('\n')) {
      if (!line) continue;
      const parts = line.split(SQL_SEP);
      if (parts.length < 9) continue;
      const [host, name, plainValue, encQuoted, p, expUtc, isSecure, isHttpOnly, ss] = parts;

      let value = plainValue;
      if (!value || value.length === 0) {
        const hex = encQuoted.match(/^X'([0-9a-fA-F]*)'$/i);
        if (!hex) continue;
        const enc = Buffer.from(hex[1], 'hex');
        if (enc.length === 0) continue;
        const prefix = enc.subarray(0, 3).toString('ascii');
        if (prefix === 'v10' || prefix === 'v11') {
          try { value = decryptV10(enc, key); } catch { continue; }
        } else if (prefix === 'v20') {
          v20Skipped++;
          continue;
        } else {
          continue;
        }
      }
      if (!value) continue;

      const expUtcNum = Number(expUtc);
      const expires = expUtcNum > 0 ? (expUtcNum - 11644473600000000) / 1_000_000 : -1;

      cookies.push({
        name,
        value,
        domain: host,
        path: p || '/',
        expires,
        secure: isSecure === '1',
        httpOnly: isHttpOnly === '1',
        sameSite: sameSiteMap(Number(ss)),
      });
    }
    return { cookies, v20Skipped };
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export function exportGoogleCookiesForEmail(email: string): ExportResult {
  const profile = findProfileByEmail(email);
  if (!profile) {
    throw new Error(
      `No Chrome profile signed into ${email}. ` +
      `Run listProfiles() to see which profiles have which emails.`,
    );
  }
  return exportCookies(profile, GOOGLE_HOST_PATTERNS);
}
