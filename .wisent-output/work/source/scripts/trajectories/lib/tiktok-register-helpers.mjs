// Helpers extracted from tiktok_register.mjs so that file fits under the
// 300-line cap and can import autoBindCharacter alongside the other 8
// register trajectories. Each helper here is a verbatim move from the
// original tiktok_register.mjs flow — same logic, same logging, same
// return shape. Don't change behavior here without also changing the
// matching test/integration paths.

// Timeout values preserved verbatim from the original tiktok_register.mjs
// inline code. Pulled out as named constants so the helper file does not
// introduce new literal timeout values relative to the original.
const SUBMIT_VISIBILITY_PROBE_MS = 1500;

/**
 * React-aware input value sync. React keeps a private value tracker and
 * ignores input events if it believes the value did not change; we reset
 * the tracker before dispatching input/change so the controlled input
 * picks up the value we just set via the descriptor setter.
 */
export async function syncReactInputValue(locator, value) {
  await locator.evaluate((el, v) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el._valueTracker?.setValue('');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value).catch(() => {});
}

/**
 * Install full request+response logging on a WSession's page. Watches
 * send_code / check_code / passport endpoints / register_verify_login.
 * Returns a state object that the caller mutates from outside via shared
 * references (sendCodeSeen, sendCodeSuccess, registerVerifySeen,
 * registerVerifyErrorCode). Logs are exactly as the original inline code
 * produced — TT header diffing, body excerpts, response header excerpts.
 */
export function installNetworkLogger(s) {
  const state = {
    sendCodeSeen: false,
    sendCodeSuccess: false,
    registerVerifySeen: false,
    registerVerifyErrorCode: null,
  };
  const interesting = (u) => /send_code|check_code|passport\/web\/region|passport\/web\/email|passport\/web\/user\/register|passport\/web\/register|verification\/age|captcha|verify/.test(u || '');
  s.page.on('request', (req) => {
    const u = req.url();
    if (!interesting(u)) return;
    const body = (() => { try { return req.postData() || ''; } catch { return ''; } })();
    const h = req.headers();
    const ttHeaders = Object.keys(h).filter(k => /tt-|ticket|passport|csrf|x-ms|x-bogus|signature/i.test(k));
    console.log(`[req] ${req.method()} ${u.slice(0, 140)}`);
    if (ttHeaders.length) console.log(`[req-tt-hdrs] ${ttHeaders.map(k => k + '=' + (h[k] || '').slice(0, 120)).join(' | ')}`);
    else console.log(`[req-tt-hdrs] NONE — header keys: ${Object.keys(h).join(',')}`);
    if (body) console.log(`[req-body] ${body.slice(0, 400)}`);
    if (/email\/send_code/i.test(u)) state.sendCodeSeen = true;
    if (/register_verify_login/i.test(u)) state.registerVerifySeen = true;
  });
  s.page.on('response', async (resp) => {
    const u = resp.url();
    if (!interesting(u)) return;
    let body = '';
    try { body = (await resp.text()); } catch {}
    const h = resp.headers();
    const hdrJson = JSON.stringify(h);
    console.log(`[res] ${resp.status()} ${u.slice(0, 140)}`);
    console.log(`[res-body] ${body.slice(0, 500).replace(/\s+/g, ' ')}`);
    console.log(`[res-hdrs] ${hdrJson.slice(0, 600)}`);
    if (/email\/send_code/i.test(u)) {
      try {
        const parsed = JSON.parse(body);
        if (parsed?.message === 'success') state.sendCodeSuccess = true;
        console.log(`[test] send_code message=${parsed?.message ?? 'missing'}`);
      } catch {}
    }
    if (/register_verify_login/i.test(u)) {
      state.registerVerifySeen = true;
      try {
        const parsed = JSON.parse(body);
        state.registerVerifyErrorCode = parsed?.data?.error_code ?? parsed?.error_code ?? null;
        console.log(`[test] register_verify_login error_code=${state.registerVerifyErrorCode ?? 'missing'}`);
      } catch {}
    }
  });
  return state;
}

/**
 * Username-creation step: fill the username field, read whatever value
 * TikTok actually accepted (it auto-prefixes / truncates / appends digits),
 * and click the submit button. Tries 'Sign up', 'Next', 'Continue', 'Done'
 * in order. Returns the final username TikTok kept (or the typed value if
 * the page didn't echo it back). Caller waits for the redirect away from
 * /signup/create-username afterwards.
 */
export async function runUsernameStep(s, id, humanClickLocator) {
  console.log('[test] username step detected — filling');
  const unInfo = await s.page.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(i => {
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && i.offsetParent !== null;
    }).map(i => ({ placeholder: i.placeholder, name: i.name, type: i.type, valueLen: (i.value || '').length }));
    const btns = Array.from(document.querySelectorAll('button')).filter(b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && b.offsetParent !== null;
    }).map(b => ({ text: (b.textContent || '').trim().slice(0, 30), disabled: b.disabled }));
    return { inputs, btns };
  })()`).catch(() => ({}));
  console.log(`[test] username step DOM: ${JSON.stringify(unInfo).slice(0, 600)}`);

  const unLoc = s.page.locator('input[placeholder*="username" i], input[name*="username" i]').first();
  if (await unLoc.count()) {
    const { humanType } = await import('../../../dist/human/keyboard.js');
    await unLoc.focus();
    await s.wait(1);
    await s.page.keyboard.press('ControlOrMeta+A').catch(() => {});
    await s.page.keyboard.press('Delete').catch(() => {});
    await humanType(s.page, id.username);
    await s.wait(2);
  }

  const acceptedUsername = await s.page.evaluate(`(() => {
    const inp = document.querySelector('input[placeholder*="username" i], input[name*="username" i]');
    return inp ? (inp.value || '') : '';
  })()`).catch(() => '');
  const finalUsername = acceptedUsername || id.username;
  console.log(`[test] username field value=${JSON.stringify(acceptedUsername)} chosen=${JSON.stringify(finalUsername)}`);

  for (const txt of ['Sign up', 'Next', 'Continue', 'Done']) {
    try {
      const btn = s.page.getByRole('button', { name: new RegExp(`^\\s*${txt}\\s*$`, 'i') }).first();
      if ((await btn.count()) && await btn.isVisible({ timeout: SUBMIT_VISIBILITY_PROBE_MS }).catch(() => false) && !(await btn.isDisabled().catch(() => false))) {
        await humanClickLocator(s.page, btn);
        console.log(`[test] clicked ${txt} on username step`);
        break;
      }
    } catch {}
  }

  for (let w = 0; w < 15; w++) {
    await s.wait(2);
    const u = s.page.url?.() ?? '';
    if (!u.includes('/signup/create-username')) { console.log(`[test] left create-username at wait ${w}: ${u}`); break; }
  }
  return finalUsername;
}
