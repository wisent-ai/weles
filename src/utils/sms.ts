/**
 * SMS verification client -- JuicySMS + sms-activate.
 * Plain HTTP GET calls, no external dependencies.
 */

import { costTracker } from './cost.js';

const JUICY_BASE = 'https://juicysms.com/api';

const SERVICE_IDS: Record<string, string> = {
  twitter: '4', tiktok: '76', instagram: '6', discord: '10',
  reddit: '474', google: '1', telegram: '5', whatsapp: '8',
  facebook: '12', yahoo: '15', linkedin: '284',
};

const COUNTRY_PREFIX: Record<string, string> = {
  US: '+1', UK: '+44', CA: '+1', NL: '+31', DE: '+49',
};

const SMSACTIVATE_SERVICES: Record<string, string> = {
  tiktok: 'lf', instagram: 'ig', discord: 'ds', reddit: 'dt',
  twitter: 'tw', google: 'go', telegram: 'tg', whatsapp: 'wa',
  facebook: 'fb', yahoo: 'mj',
};
const SMSACTIVATE_COUNTRIES: Record<string, string> = {
  US: '12', UK: '16', NL: '15', DE: '43',
};

export interface SmsNumber { phone: string; orderId: string; provider: 'juicysms' | 'smsactivate'; country: string; }

function normalizePhone(raw: string, country: string): string {
  let p = raw.replace(/\D/g, '');
  if (country !== 'US' && p.startsWith('0')) p = p.slice(1);
  const pfx = COUNTRY_PREFIX[country] ?? '+1';
  return p.startsWith('+') ? p : `${pfx}${p}`;
}

export async function getNumber(service: string, country = 'UK'): Promise<SmsNumber | null> {
  // Try JuicySMS — only the requested country (caller handles rotation)
  const jKey = process.env.JUICYSMS_API_KEY;
  if (jKey) {
    const sid = SERVICE_IDS[service.toLowerCase()] ?? service;
    const url = `${JUICY_BASE}/makeorder?key=${jKey}&serviceId=${sid}&country=${country}`;
    const r = await fetch(url).catch(() => null);
    const text = (await r?.text())?.trim() ?? '';
    const m = text.match(/ORDER_ID_(\d+)_NUMBER_(\d+)/);
    if (m) {
      console.log(`[sms] juicysms: got ${m[2]} (order ${m[1]}, ${country})`);
      costTracker.recordSms('juicysms', service);
      return { phone: normalizePhone(m[2], country), orderId: m[1], provider: 'juicysms', country };
    }
    if (text.includes('OPEN_ORDER')) {
      const oid = text.match(/(\d+)/)?.[1];
      if (oid) { await fetch(`${JUICY_BASE}/cancelorder?key=${jKey}&orderId=${oid}`).catch(() => {}); }
      const r2 = await fetch(url).catch(() => null);
      const t2 = (await r2?.text())?.trim() ?? '';
      const m2 = t2.match(/ORDER_ID_(\d+)_NUMBER_(\d+)/);
      if (m2) {
        costTracker.recordSms('juicysms', service);
        return { phone: normalizePhone(m2[2], country), orderId: m2[1], provider: 'juicysms', country };
      }
    }
    console.log(`[sms] juicysms (${country}): ${text.slice(0, 60)}`);
  }
  // Try sms-activate
  const saKey = process.env.SMSACTIVATE_API_KEY;
  if (saKey) {
    const svc = SMSACTIVATE_SERVICES[service.toLowerCase()] ?? service;
    const cc = SMSACTIVATE_COUNTRIES[country] ?? '12';
    const url = `https://api.sms-activate.org/stubs/handler_api.php?api_key=${saKey}&action=getNumberV2&service=${svc}&country=${cc}`;
    const r = await fetch(url).catch(() => null);
    if (r?.ok) {
      const d = await r.json().catch(() => ({})) as any;
      if (d.activationId) {
        const phone = String(d.phoneNumber ?? '');
        console.log(`[sms] sms-activate: got ${phone} (activation ${d.activationId})`);
        await fetch(`https://api.sms-activate.org/stubs/handler_api.php?api_key=${saKey}&action=setStatus&status=1&id=${d.activationId}`).catch(() => {});
        costTracker.recordSms('smsactivate', service);
        return { phone: normalizePhone(phone, country), orderId: String(d.activationId), provider: 'smsactivate', country };
      }
    }
  }
  console.log(`[sms] no provider available for ${service}`);
  return null;
}

/** Poll for SMS code. waitSecs = max seconds to wait (default 90). */
export async function pollCode(orderId: string, provider: 'juicysms' | 'smsactivate', waitSecs = 90): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < waitSecs * 1000) {
    if (provider === 'juicysms') {
      const jKey = process.env.JUICYSMS_API_KEY!;
      const r = await fetch(`${JUICY_BASE}/getsms?key=${jKey}&orderId=${orderId}`).catch(() => null);
      const text = (await r?.text())?.trim() ?? '';
      if (text.startsWith('SUCCESS_')) { const code = text.replace('SUCCESS_', '').match(/(\d{4,8})/)?.[1]; if (code) { console.log(`[sms] code: ${code}`); return code; } }
      if (!text.includes('WAIT') && text !== '') console.log(`[sms] juicysms poll: ${text.slice(0, 60)}`);
    } else {
      const saKey = process.env.SMSACTIVATE_API_KEY!;
      const r = await fetch(`https://api.sms-activate.org/stubs/handler_api.php?api_key=${saKey}&action=getStatus&id=${orderId}`).catch(() => null);
      const text = (await r?.text())?.trim() ?? '';
      if (text.startsWith('STATUS_OK:')) { const code = text.split(':')[1].match(/(\d{4,8})/)?.[1]; if (code) { console.log(`[sms] code: ${code}`); return code; } }
      if (text.includes('STATUS_CANCEL')) { console.log('[sms] activation cancelled'); return null; }
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed % 15 === 0) console.log(`[sms] waiting for code... (${elapsed}s / ${waitSecs}s)`);
    await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
  }
  // Skip (not cancel) — prevents getting the same dead number again. Free if SMS wasn't delivered.
  if (provider === 'juicysms') {
    await fetch(`${JUICY_BASE}/skipnumber?key=${process.env.JUICYSMS_API_KEY}&orderId=${orderId}`).catch(() => {});
  } else { await cancelOrder(orderId, provider); }
  return null;
}

export async function cancelOrder(orderId: string, provider: 'juicysms' | 'smsactivate'): Promise<void> {
  if (provider === 'juicysms') {
    await fetch(`${JUICY_BASE}/cancelorder?key=${process.env.JUICYSMS_API_KEY}&orderId=${orderId}`).catch(() => {});
  } else {
    await fetch(`https://api.sms-activate.org/stubs/handler_api.php?api_key=${process.env.SMSACTIVATE_API_KEY}&action=setStatus&status=8&id=${orderId}`).catch(() => {});
  }
}
