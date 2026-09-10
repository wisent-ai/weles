import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

/**
 * Everything the page lets us read at a stuck point: inputs and their
 * validity, buttons, error tips, storage, the recent TikTok resource timings,
 * the SIGI_STATE keys and every click the form received. Written beside the
 * run's recordings for a later diff against a run that got through.
 */
function readPageState(page) {
  return page.evaluate(() => {
    const out = { ts: Date.now(), url: location.href };
    const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ placeholder: i.placeholder, name: i.name, type: i.type, valueLen: (i.value||'').length, validity: { valid: i.validity?.valid, badInput: i.validity?.badInput, valueMissing: i.validity?.valueMissing, customError: i.validity?.customError, validationMessage: i.validationMessage } }));
    const btns = Array.from(document.querySelectorAll('button')).map(b => ({ text: (b.textContent||'').trim().slice(0,30), disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled'), dataE2e: b.getAttribute('data-e2e'), cls: (b.className||'').toString().slice(0,80) }));
    const errs = Array.from(document.querySelectorAll('[class*="error" i],[class*="tip" i],[class*="warning" i]')).map(e => (e.textContent||'').trim().slice(0,200)).filter(Boolean);
    const cookies = document.cookie;
    // Keys come from the storage itself, so every read below is of a present key.
    const ls = {}; try { for (const k of Object.keys(localStorage)) ls[k] = String(localStorage.getItem(k)).slice(0,200); } catch {}
    const ss = {}; try { for (const k of Object.keys(sessionStorage)) ss[k] = String(sessionStorage.getItem(k)).slice(0,200); } catch {}
    const perf = performance.getEntriesByType('resource').filter(e => /tiktok|mssdk|ttwid|passport|verification/.test(e.name)).slice(-50).map(e => ({ name: e.name.slice(0,200), duration: Math.round(e.duration), responseEnd: Math.round(e.responseEnd), transferSize: e.transferSize }));
    const sigiTag = document.querySelector('script#SIGI_STATE') || document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    let sigiKeys = null; if (sigiTag) { try { const j = JSON.parse(sigiTag.textContent || '{}'); sigiKeys = Object.keys(j); } catch {} }
    const wclick = window.__wclick || [];
    const root = document.documentElement;
    const themeAttr = [root.getAttribute('data-theme'), root.getAttribute('class')].find(Boolean) ?? '';
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const bodyText = (document.body.innerText||'').slice(0,1500);
    return { ...out, inputs, btns, errs, cookies, ls, ss, perf, sigiKeys, wclick, themeAttr, colorScheme, bodyText };
  });
}

/**
 * Dump the stuck page state and the context cookies for the given stage
 * ('send_code_no_advance' or 'next_no_account'). A dump that itself fails is
 * logged; the registration attempt continues regardless.
 */
export async function dumpStuckState(s, stage) {
  try {
    const dump = await readPageState(s.page);
    const ctxCookies = await s.ctx.cookies();
    const dir = runRecordingsDir('tiktok_register');
    mkdirSync(dir, { recursive: true });
    const fname = join(dir, `${stage}_${Date.now()}.json`);
    writeFileSync(fname, JSON.stringify({ stage, dump, ctxCookies }, null, 2));
    console.log(`[stuck-diag] dumped ${stage} state to ${fname}`);
  } catch (e) { console.log(`[stuck-diag] err: ${e.message?.slice(0,200)}`); }
}
