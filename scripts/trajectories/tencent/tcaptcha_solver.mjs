// Tencent TC-Captcha (drag-element) solver via 2Captcha TencentTaskProxyless.
// Used by tencent/login.mjs to satisfy the captcha overlay on /verify.

const KEY = process.env.TWOCAPTCHA_API_KEY;

export async function findCaptchaAppId(page) {
  // Try main page: HTML, scripts, window props.
  const fromMain = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const patterns = [
      /["']appId["']\s*:\s*["']?(\d{8,12})/i,
      /captchaAppId\s*[:=]\s*["']?(\d{8,12})/i,
      /aid["']?\s*[:=]\s*["']?(\d{8,12})/i,
      /appid=(\d{8,12})/i,
      /TencentCaptcha\s*\(\s*['"]?(\d{8,12})/i,
      /new\s+TencentCaptcha\s*\(\s*[^,]*,\s*['"]?(\d{8,12})/i,
      /aid=(\d{8,12})/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return { src: 'html', appId: m[1] };
    }
    for (const k of ['captcha', 'tencentCaptcha', 'TencentCaptcha', 'tcOptions']) {
      const v = (window)[k];
      if (v && (v.appId || v.aid)) return { src: 'window.' + k, appId: String(v.appId || v.aid) };
    }
    return null;
  }).catch(() => null);
  if (fromMain) { console.log(`[tcaptcha] appId from main page: ${JSON.stringify(fromMain)}`); return fromMain.appId; }
  // Network resource entries — only captchaapi.tencentcloudcs.com URLs
  // host the real captcha appId; rumt-sg.com / RUM telemetry hosts a
  // hex appId (01111011-...) that my regex previously false-matched.
  const fromNet = await page.evaluate(() => {
    const ents = performance.getEntriesByType('resource').map(e => e.name);
    for (const u of ents) {
      if (!/captchaapi\.tencentcloudcs\.com|cap_union|cap_anti/.test(u)) continue;
      const m = u.match(/aid=(\d{8,12})/i);
      if (m) return { src: 'captcha-perf', appId: m[1], url: u };
    }
    return null;
  }).catch(() => null);
  if (fromNet) { console.log(`[tcaptcha] appId from network: ${JSON.stringify(fromNet)}`); return fromNet.appId; }
  // Try inside the captcha iframe — its URL ends with .../drag_ele_global.custom.X.html
  for (const f of page.frames()) {
    if (!/captchacdn\.tencentcloudcs\.com|drag_ele_global/.test(f.url())) continue;
    const fromFrame = await f.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const m = html.match(/aid["']?\s*[:=]\s*["']?(\d{8,12})/i) || html.match(/appid["']?\s*[:=]\s*["']?(\d{8,12})/i);
      if (m) return { src: 'frame-html', appId: m[1] };
      const search = location.search || '';
      const sm = search.match(/aid=(\d{8,12})/i);
      if (sm) return { src: 'frame-query', appId: sm[1] };
      const refm = (document.referrer || '').match(/aid=(\d{8,12})/i);
      if (refm) return { src: 'referrer', appId: refm[1] };
      return null;
    }).catch(() => null);
    if (fromFrame) { console.log(`[tcaptcha] appId from frame: ${JSON.stringify(fromFrame)}`); return fromFrame.appId; }
  }
  return null;
}

async function submitTask(appId, websiteURL) {
  if (!KEY) throw new Error('TWOCAPTCHA_API_KEY not set');
  const r = await fetch('https://api.2captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: KEY, task: { type: 'TencentTaskProxyless', appId, websiteURL } }),
  });
  const j = await r.json();
  if (!j.taskId) throw new Error(`2captcha createTask: ${JSON.stringify(j)}`);
  return j.taskId;
}

async function pollResult(taskId, attempts = 60) {
  if (attempts <= 0) throw new Error('2captcha poll budget exhausted');
  await new Promise((r) => setTimeout(r, 5000));
  const r = await fetch('https://api.2captcha.com/getTaskResult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: KEY, taskId }),
  });
  const j = await r.json();
  if (j.status === 'ready') return j.solution;
  if (j.errorId) throw new Error('2captcha error: ' + JSON.stringify(j));
  return pollResult(taskId, attempts - 1);
}

export async function solveTencentCaptcha(page, appId) {
  if (!appId) appId = await findCaptchaAppId(page);
  if (!appId) throw new Error('cannot locate captcha appId on page');
  console.log(`[tcaptcha] solving with appId=${appId} via 2Captcha`);
  const taskId = await submitTask(appId, page.url());
  console.log(`[tcaptcha] taskId=${taskId} submitted; waiting for solution`);
  const sol = await pollResult(taskId);
  console.log(`[tcaptcha] solution received: ticket=${(sol?.ticket || '').slice(0, 16)}... randstr=${sol?.randstr}`);
  return { ...sol, appid: appId };
}

export async function injectCaptchaSolution(page, sol) {
  return await page.evaluate((s) => {
    const cb = (window).captchaCallback || (window).TencentCaptcha?.callback || (window).cb;
    if (typeof cb === 'function') { cb(s); return 'captchaCallback'; }
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage(JSON.stringify({ ret: 0, ...s }), '*'); return 'postMessage'; } catch {}
    }
    return 'no-callback-found';
  }, sol).catch((e) => 'evaluate-error: ' + e.message);
}
