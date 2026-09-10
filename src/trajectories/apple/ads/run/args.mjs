// The environment an Apple Ads action arrives as, and the helpers that turn it into `asc ads` arguments.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ASC_BIN = process.env.ASC_BIN || 'asc';
export const action = process.env.APPLE_ADS_ACTION || 'ads_campaigns';
export const org = process.env.ASC_ADS_ORG_ID;
export const adsProfile = process.env.APPLE_ADS_PROFILE_NAME;
export const confirmed = process.env.APPLE_ADS_CONFIRM === '1'
  || process.env.WRITE_CONFIRM === '1'
  || process.env.SUBMIT === '1';

export function value(name, fallback = undefined) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

export function requireValue(name, label = name) {
  const v = value(name);
  if (!v) {
    console.log(`FAIL: ${label} is required for ${action}`);
    process.exit(1);
  }
  return v;
}

export function withOrg(args) {
  let out = args;
  if (org) out = [...out, '--org', org];
  if (adsProfile) out = [...out, '--ads-profile', adsProfile];
  return out;
}

export function withOutput(args) {
  if (process.env.APPLE_ADS_NO_OUTPUT === '1') return args;
  if (args[0] === 'ads' && args[1] === 'auth' && ['login', 'logout', 'switch'].includes(args[2])) return args;
  return args.includes('--output') ? args : [...args, '--output', 'json'];
}

export function withOptional(args, flag, envName) {
  const v = value(envName);
  return v ? [...args, flag, v] : args;
}

export function appendPaging(args) {
  let out = args;
  out = withOptional(out, '--limit', 'LIMIT');
  out = withOptional(out, '--offset', 'OFFSET');
  if (process.env.PAGINATE === '1') out = [...out, '--paginate'];
  return out;
}

export async function payloadFile() {
  const existing = value('APPLE_ADS_FILE');
  if (existing) return existing;
  const json = value('APPLE_ADS_PAYLOAD_JSON');
  if (!json) return null;
  const dir = await mkdtemp(join(tmpdir(), 'weles-apple-ads-'));
  const file = join(dir, 'request.json');
  await writeFile(file, json);
  return file;
}

export function splitArgs(s) {
  if (!s) return [];
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && i + 1 < s.length) {
        i += 1;
        cur += s[i];
      } else cur += ch;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else cur += ch;
  }
  if (q) throw new Error('APPLE_ADS_CLI_ARGS has an unterminated quote');
  if (cur) out.push(cur);
  return out;
}

export function ensureConfirmed(kind) {
  if (!confirmed) {
    console.log(`FAIL: ${action} would ${kind}; set apple_ads_confirm=true, write_confirm=true, or submit=true in params to proceed.`);
    process.exit(2);
  }
}

export function ensureCliArgsAllowed(args) {
  const joined = args.join(' ').toLowerCase();
  const mutating = /\b(create|update|delete|pause|resume|login|logout|token)\b/.test(joined)
    || (/\brequest\b/.test(joined) && /\b--method\s+(post|put|patch|delete)\b/.test(joined));
  if (mutating) ensureConfirmed(`run mutating/sensitive asc args: ${args.join(' ')}`);
}

export function reportPresetArgs() {
  let args = ['ads', 'reports', 'preset'];
  args = withOptional(args, '--level', 'APPLE_ADS_REPORT_LEVEL');
  args = withOptional(args, '--from', 'APPLE_ADS_FROM');
  args = withOptional(args, '--to', 'APPLE_ADS_TO');
  args = withOptional(args, '--last-days', 'APPLE_ADS_LAST_DAYS');
  args = withOptional(args, '--fields', 'FIELDS');
  args = withOptional(args, '--sort', 'APPLE_ADS_SORT');
  args = withOptional(args, '--granularity', 'APPLE_ADS_GRANULARITY');
  args = withOptional(args, '--time-zone', 'APPLE_ADS_TIME_ZONE');
  args = withOptional(args, '--campaign', 'APPLE_ADS_CAMPAIGN_ID');
  args = withOptional(args, '--ad-group', 'APPLE_ADS_AD_GROUP_ID');
  args = withOptional(args, '--limit', 'LIMIT');
  args = withOptional(args, '--offset', 'OFFSET');
  if (process.env.RETURN_ROW_TOTALS === '1' || process.env.RETURN_ROW_TOTALS === 'true') args.push('--return-row-totals');
  return withOrg(args);
}

export function requireValueFrom(v, label) {
  if (!v) {
    console.log(`FAIL: ${label} is required for ${action}`);
    process.exit(1);
  }
  return v;
}
