// The captcha widget as LinkedIn's challenge page embeds it: its sitekey, the frame that
// holds the token field, the data-s value, and the form submission that carries the token.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';

export async function getCaptchaSitekey(page) {
  // LinkedIn's challenge iframe embeds a reCAPTCHA enterprise widget whose
  // sitekey is in the iframe src (6LcIy_Mq...). The hidden form also carries
  // a wrapper sitekey (6LfmKkwr...). The token must be produced for the actual
  // widget key, so prefer the iframe src key and fall back to the form key.
  const frames = page.frames();
  for (const frame of frames) {
    const src = await frame.evaluate(() => {
      const f = document.querySelector('iframe[src*="recaptcha"]');
      return f ? f.src : '';
    }).catch(() => '');
    const m = src.match(/[?&]k=([^&]+)/);
    if (m) return m[1];
  }
  for (const frame of frames) {
    const formKey = await frame.evaluate(() => {
      const el = document.querySelector('input[name="captchaSiteKey"]');
      return el ? el.value : '';
    }).catch(() => '');
    if (formKey) return formKey;
  }
  return null;
}

export async function findCaptchaTokenContext(page) {
  // Main frame first.
  let tokenInput = page.locator('input[name="captchaUserResponseToken"]').first();
  if (await tokenInput.count()) return { frame: page.mainFrame(), tokenInput };
  // LinkedIn wraps the challenge in iframe#captcha-internal.
  const captchaIframe = page.locator('iframe#captcha-internal').first();
  if (await captchaIframe.count()) {
    const handle = await captchaIframe.elementHandle().catch(() => null);
    const frame = handle ? await handle.contentFrame().catch(() => null) : null;
    if (frame) {
      tokenInput = frame.locator('input[name="captchaUserResponseToken"]').first();
      if (await tokenInput.count()) return { frame, tokenInput };
    }
  }
  // Generic frame search.
  for (const frame of page.frames()) {
    tokenInput = frame.locator('input[name="captchaUserResponseToken"]').first();
    if (await tokenInput.count()) return { frame, tokenInput };
  }
  return null;
}

export async function getChallengeDataS(page) {
  // LinkedIn's challenge form carries a hidden _s input (reCAPTCHA Enterprise payload).
  // Use frame.evaluate with a short timeout so a frozen/cross-origin frame cannot block.
  const frames = page.frames();
  console.log(`[create_account_challenge] data-s scanning ${frames.length} frames`);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const v = await frame.evaluate(() => {
      const el = document.querySelector('input[name="_s"]');
      return el && el.value ? el.value : '';
    }, undefined, { timeout: 3000 }).catch((e) => { console.log(`[create_account_challenge] data-s frame ${i} err: ${e.message?.slice(0, 60)}`); return ''; });
    if (v) { console.log(`[create_account_challenge] data-s found in frame ${i}`); return v; }
  }
  console.log('[create_account_challenge] data-s not found in any frame');
  return null;
}

export async function submitLinkedinCaptchaForm(page, token, sitekey, dataS) {
  const ctx = await findCaptchaTokenContext(page);
  if (!ctx) return { ok: false, reason: 'token_input_not_found' };
  const { frame, tokenInput } = ctx;
  console.log(`[create_account_challenge] captcha token input found in frame=${frame.url?.() ?? 'main'}`);

  try {
    await tokenInput.waitFor({ state: 'attached', timeout: 10_000 });
  } catch (e) {
    return { ok: false, reason: `token_input_not_attached: ${e.message?.slice(0, 80)}` };
  }

  await tokenInput.evaluate((el, t) => {
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, token);
  // LinkedIn's challenge requires the hidden _s (reCAPTCHA Enterprise payload)
  // to be submitted together with the token. Inject it into the form if present.
  if (dataS) {
    try {
      const sInput = frame.locator('input[name="_s"]').first();
      if (await sInput.count()) {
        await sInput.evaluate((el, v) => { el.value = v; }, dataS);
        console.log('[create_account_challenge] _s value aligned');
      } else {
        await frame.evaluate((v) => {
          const form = document.querySelector('form#captcha-challenge');
          if (!form) return;
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = '_s';
          input.value = v;
          form.appendChild(input);
        }, dataS);
        console.log('[create_account_challenge] _s input injected into challenge form');
      }
    } catch (e) {
      console.log(`[create_account_challenge] _s inject skipped: ${e.message?.slice(0, 80)}`);
    }
  }
  // Ensure the form sitekey matches the key the token was generated for.
  if (sitekey) {
    try {
      const sitekeyInput = frame.locator('input[name="captchaSiteKey"]').first();
      if (await sitekeyInput.count()) {
        await sitekeyInput.evaluate((el, k) => { el.value = k; }, sitekey);
        console.log('[create_account_challenge] captchaSiteKey aligned to token sitekey');
      }
    } catch (e) {
      console.log(`[create_account_challenge] captchaSiteKey align skipped: ${e.message?.slice(0, 80)}`);
    }
  }
  // LinkedIn's backend may validate the standard g-recaptcha-response textarea
  // rather than (or in addition to) its own wrapper input.
  try {
    const gResp = frame.locator('textarea[name="g-recaptcha-response"]').first();
    if (await gResp.count()) {
      await gResp.evaluate((el, t) => {
        el.value = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, token);
      console.log('[create_account_challenge] captcha token also injected into g-recaptcha-response');
    }
  } catch (e) {
    console.log(`[create_account_challenge] g-recaptcha-response inject skipped: ${e.message?.slice(0, 80)}`);
  }
  console.log('[create_account_challenge] captcha token injected');

  // Try to invoke the reCAPTCHA callback in the main frame first. LinkedIn's
  // reCAPTCHA Enterprise widget is registered on the top-level window; calling
  // the callback from the challenge iframe often misses the handler. Pass the
  // token so LinkedIn's own handler continues the createAccount flow.
  const callbackInvoked = await page.evaluate(async ({ t, sk }) => {
    const tryInvoke = (win) => {
      const cfg = win.___grecaptcha_cfg;
      if (!cfg?.clients) return false;
      for (const id of Object.keys(cfg.clients)) {
        const client = cfg.clients[id];
        // Modern reCAPTCHA Enterprise stores the callback under multiple shapes.
        const cb = client?.l || client?.callback || client?.B || client?.L || client?.K || client?.M || client?.N || client?.C || null;
        if (typeof cb === 'function') {
          try { cb(t); return true; } catch (e) { console.log('callback err', e?.message); }
        }
      }
      return false;
    };
    if (tryInvoke(window)) return true;

    // If no standalone callback found, try to derive it from the rendered widget.
    if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise) {
      try {
        await new Promise((resolve) => grecaptcha.enterprise.ready(resolve));
        // Reset then execute with our token pre-seeded in the response getter.
        // This lets LinkedIn's existing submit handler read our solver token
        // as if reCAPTCHA produced it itself.
        const originalGetResponse = grecaptcha.enterprise.getResponse;
        grecaptcha.enterprise.getResponse = (optWidgetId) => {
          const real = originalGetResponse(optWidgetId);
          return real && typeof real === 'string' && real.length > 10 ? real : t;
        };
        try {
          grecaptcha.enterprise.reset?.(sk);
          await grecaptcha.enterprise.execute(sk, { action: 'signup' });
        } finally {
          grecaptcha.enterprise.getResponse = originalGetResponse;
        }
        return true;
      } catch (e) {
        console.log('enterprise execute err', e?.message);
      }
    }
    return false;
  }, { t: token, sk: sitekey });
  if (callbackInvoked) {
    console.log('[create_account_challenge] reCAPTCHA main-frame callback/execute invoked');
    await humanIdlePause('short');
    return { ok: true };
  }

  // Prefer clicking the visible submit button over form.submit() — LinkedIn's
  // challenge iframe often blocks programmatic submit and expects a user click.
  const buttonSelectors = [
    'form#captcha-challenge button[type="submit"]',
    'form#captcha-challenge button',
    'button[type="submit"]',
    'button:has-text("Verify")',
    'button:has-text("Join")',
    'button:has-text("Continue")',
    'button:has-text("Submit")',
    'input[type="submit"]',
  ];

  // Debug: dump the challenge iframe DOM so we can see what submit targets exist.
  try {
    const domInfo = await frame.evaluate(() => {
      const out = {
        url: location.href,
        title: document.title,
        forms: Array.from(document.querySelectorAll('form')).map(f => ({ id: f.id, action: f.action, method: f.method, outerHTML: f.outerHTML.slice(0, 500) })),
        buttons: Array.from(document.querySelectorAll('button, input[type="submit"]')).map(b => ({ tag: b.tagName, type: b.type, id: b.id, text: b.textContent?.slice(0, 40), outerHTML: b.outerHTML.slice(0, 300) })),
        recaptcha: Array.from(document.querySelectorAll('iframe[src*="recaptcha"], .g-recaptcha, textarea[name="g-recaptcha-response"], input[name="captchaUserResponseToken"]')).map(el => ({ tag: el.tagName, name: el.name, id: el.id, src: el.src, outerHTML: el.outerHTML.slice(0, 300) })),
      };
      return out;
    });
    console.log('[create_account_challenge] challenge iframe DOM dump:', JSON.stringify(domInfo, null, 2));
  } catch (e) {
    console.log(`[create_account_challenge] DOM dump failed: ${e.message?.slice(0, 80)}`);
  }

  for (const sel of buttonSelectors) {
    const btn = frame.locator(sel).filter({ visible: true }).first();
    if (await btn.count() && await btn.isEnabled().catch(() => false)) {
      console.log(`[create_account_challenge] clicking captcha submit button: ${sel}`);
      await humanClickLocator(page, btn);
      return { ok: true };
    }
  }

  // Fallback 1: plain form submit inside the iframe. The form is hidden and
  // the iframe sandbox may block top navigation, but a same-origin POST to the
  // iframe's own location is usually allowed and is the closest thing to a
  // real user clicking "Verify".
  const form = frame.locator('form#captcha-challenge').first();
  if (await form.count()) {
    console.log('[create_account_challenge] submitting captcha form via form.submit()');
    try {
      await Promise.race([
        form.evaluate((f) => f.submit()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('form.submit timeout')), 5000)),
      ]);
      await frame.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    } catch (e) {
      console.log(`[create_account_challenge] form.submit() failed or timed out: ${e.message?.slice(0, 120)}`);
    }
    return { ok: true };
  }

  return { ok: false, reason: 'no_submit_target_found' };
}
