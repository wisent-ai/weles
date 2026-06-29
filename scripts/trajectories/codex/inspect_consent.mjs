import { WSession } from '../../../dist/session/wsession.js';
import { doGoogleSso, waitForEnabledThenClick } from './google_sso.mjs';

const login = {
  email: process.env.CODEX_EMAIL || '',
  password: process.env.CODEX_PASSWORD || '',
};
if (!login.email || !login.password) {
  console.error('Set CODEX_EMAIL and CODEX_PASSWORD');
  process.exit(1);
}

const session = await WSession.start({ label:'inspect_consent', headless:false, browser:'chromium' });
const page = session.page;

// Get a real device URL from codex CLI would be better; use placeholder and poll
const { spawn } = await import('node:child_process');
const cp = spawn('codex', ['login', '--device-auth'], { env: { ...process.env, OPENAI_API_KEY: '' }, stdio: 'pipe' });
let deviceUrl = '', deviceCode = '';
const outChunks = [];
for await (const chunk of cp.stdout) outChunks.push(chunk);
const err = (await cp.stderr.toArray?.()) || [];
const output = Buffer.concat(outChunks).toString('utf8');
console.log('codex stdout:', output.slice(0,500));
const m = output.match(/(https:\/\/auth\.openai\.com\/codex\/device\?[^\s]+)/);
if (m) deviceUrl = m[1];
const cm = output.match(/Your device code is:\s*([A-Z0-9-]+)/i) || output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,})\b/);
if (cm) deviceCode = cm[1];
console.log('deviceUrl:', deviceUrl, 'code:', deviceCode);
if (!deviceUrl) { console.error('no device url'); await session.close(); process.exit(1); }

try {
  await doGoogleSso({
    page, login, authorizeUrl: deviceUrl, mark: () => {},
    humanFill: async (p, loc, text) => { await loc.fill(text); },
    humanClickLocator: async (p, loc) => { await loc.click(); },
    humanIdlePause: async () => { await page.waitForTimeout(500); },
    humanType: async (p, text) => { await page.keyboard.type(text); },
  });
} catch (e) {
  console.log('google sso result:', e.message);
}

// wait for chatgpt consent page or OpenAI login
for (let i=0;i<100;i++){
  const url = page.url();
  const body = await page.evaluate(()=>document.body?.innerText||'').catch(()=>'');
  console.log(`poll ${i}: ${url} | ${body.slice(0,80)}`);
  if (/chatgpt\.com/.test(url) || /auth\.openai\.com/.test(url)) break;
  await page.waitForTimeout(300);
}
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const links = Array.from(document.querySelectorAll('a')).map(a => ({ href: a.href, txt: (a.innerText||'').trim().slice(0,120) }));
  const buttons = Array.from(document.querySelectorAll('button')).map(b => ({ txt: (b.innerText||'').trim().slice(0,80), disabled: b.disabled }));
  return { url: location.href, title: document.title, body: (document.body?.innerText||'').slice(0,800), links, buttons };
});
console.log('=== CONSENT PAGE ===');
console.log(JSON.stringify(info, null, 2));

await session.close();
