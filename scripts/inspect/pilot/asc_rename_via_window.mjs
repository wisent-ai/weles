// Drive the already-open, logged-in App Store Connect weles window (pipe
// transport, no CDP port) through the pilot node process's V8 inspector.
// This read-first variant navigates to a page and dumps its inputs/headings so
// the exact Name field can be identified before any edit. Never closes the
// browser. See reference_drive_live_weles_via_node_inspector.
//
// Env: PID (pilot pid, default 63145), URL (page to inspect), INSPECT_PORT (9229).
import { setTimeout as sleep } from 'node:timers/promises';

const PID = Number(process.env.PID || 63145);
const PORT = Number(process.env.INSPECT_PORT || 9229);
const APP_ID = process.env.APP_ID || '6782221156';
const URL = process.env.URL || `https://appstoreconnect.apple.com/apps/${APP_ID}/distribution/info`;
const NEW_NAME = process.env.NEW_NAME || '';
const WSESSION_JS = process.env.WSESSION_JS
  || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/dist/session/wsession.js';

process.kill(PID, 'SIGUSR1');
await sleep(1000);

let wsUrl = '';
for (let i = 0; i < 20; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list?.[0]?.webSocketDebuggerUrl || '';
    if (wsUrl) break;
  } catch { /* inspector not up yet */ }
  await sleep(500);
}
if (!wsUrl) { console.log('FAIL: inspector ws url not found on', PORT); process.exit(1); }

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
await send('Runtime.enable');

const protoExpr = `(()=>{const M=process.getBuiltinModule('module');const req=M.createRequire('file://${WSESSION_JS}');return req('${WSESSION_JS}').WSession.prototype;})()`;
const ev1 = await send('Runtime.evaluate', { expression: protoExpr });
const protoId = ev1.result?.result?.objectId;
if (!protoId) { console.log('FAIL: WSession.prototype not resolved:', JSON.stringify(ev1.result)); process.exit(1); }
const q = await send('Runtime.queryObjects', { prototypeObjectId: protoId });
const arrId = q.result?.objects?.objectId;
if (!arrId) { console.log('FAIL: queryObjects returned no array'); process.exit(1); }

const CREATE_BUNDLE = process.env.CREATE_BUNDLE || '';
const CREATE_NAME = process.env.CREATE_NAME || '';
const CREATE_SKU = process.env.CREATE_SKU || '';
const RETURN_URL = process.env.RETURN_URL || '';

const createAction = `
  async function(){
    const s=this[this.length-1]; const p=s.page;
    const NAME=${JSON.stringify(CREATE_NAME)}, BUNDLE=${JSON.stringify(CREATE_BUNDLE)}, SKU=${JSON.stringify(CREATE_SKU)};
    const log=[];
    await p.goto('https://appstoreconnect.apple.com/apps');
    await p.waitForTimeout(3500);
    log.push('apps url='+p.url());
    const addBtn = p.getByRole('button', {name:/^add\\b|new app|add app|^\\+$/i}).first();
    if (await addBtn.count()) { await addBtn.click(); log.push('clicked add'); }
    await p.waitForTimeout(1400);
    const newApp = p.getByRole('menuitem', {name:/new app/i}).first();
    if (await newApp.count()) { await newApp.click(); log.push('clicked new app (menuitem)'); }
    else { const t=p.getByText(/^\\s*new app\\s*$/i).first(); if (await t.count()) { await t.click(); log.push('clicked new app (text)'); } }
    await p.waitForTimeout(2800);
    const ios = p.getByRole('checkbox', {name:/ios/i}).first();
    if (await ios.count() && !(await ios.isChecked())) { await ios.click(); log.push('checked iOS'); }
    let nameSet=false;
    for (const loc of [p.getByLabel(/^name$/i).first(), p.getByPlaceholder(/name/i).first(), p.getByRole('textbox').first()]) {
      if (await loc.count()) { await loc.fill(NAME); nameSet=true; log.push('name set'); break; }
    }
    await p.waitForTimeout(500);
    const lang = p.getByLabel(/primary language/i).first();
    if (await lang.count()) { await lang.selectOption('en-US'); log.push('lang en-US'); }
    await p.waitForTimeout(500);
    const bun = p.getByLabel(/bundle id/i).first();
    if (await bun.count()) {
      const frag=BUNDLE.split('.').pop();
      const val = await bun.evaluate((el, f) => { const o=[...el.options].find(x=>(x.textContent||'').toLowerCase().includes(f)); return o ? o.value : ''; }, frag);
      if (val) { await bun.selectOption(val); log.push('bundle val='+val); } else { log.push('bundle option not found'); }
    }
    await p.waitForTimeout(500);
    for (const loc of [p.getByLabel(/^sku$/i).first(), p.getByPlaceholder(/sku/i).first()]) {
      if (await loc.count()) { await loc.fill(SKU); log.push('sku set'); break; }
    }
    await p.waitForTimeout(500);
    const full = p.getByRole('radio', {name:/full access|full/i}).first();
    if (await full.count()) { await full.click(); log.push('full access'); }
    await p.waitForTimeout(400);
    const createBtn = p.getByRole('button', {name:/^\\s*create\\s*$/i}).first();
    if (await createBtn.count()) { await createBtn.click(); log.push('clicked create'); }
    await p.waitForTimeout(6000);
    const after = p.url();
    if (${JSON.stringify(RETURN_URL)}) { await p.goto(${JSON.stringify(RETURN_URL)}); await p.waitForTimeout(1500); }
    return {nameSet, afterUrl: after, log};
  }`;

const action = CREATE_BUNDLE ? createAction : NEW_NAME ? `
  async function(){
    const s=this[this.length-1]; const p=s.page;
    const name = p.getByRole('textbox', {name:'Name', exact:true}).first();
    const before = await name.inputValue();
    await name.fill(${JSON.stringify(NEW_NAME)});
    await p.waitForTimeout(700);
    const after = await name.inputValue();
    const saveBtn = p.getByRole('button', {name:'Save'}).first();
    await saveBtn.click();
    await p.waitForTimeout(6000);
    const confirm = await name.inputValue();
    const snap = await p.locator('main').ariaSnapshot();
    const hasError = snap.includes('errors on this page');
    let errText=''; const i = snap.indexOf("Name couldn"); if (i>=0) errText = snap.slice(i, i+170);
    return {before, after, confirm, hasError, errText};
  }` : `
  async function(){
    const s=this[this.length-1]; const p=s.page;
    await p.waitForTimeout(1000);
    let nameVal='';
    try { nameVal = await p.getByRole('textbox', {name:'Name', exact:true}).first().inputValue(); } catch(e){ nameVal='(name field not read: '+e.message+')'; }
    let snap='';
    try { snap = await p.locator('main').ariaSnapshot(); } catch(e){ snap = 'snap-failed: '+e.message; }
    return {url:p.url(), nameVal, snap: snap.slice(0, 9000)};
  }`;

const call = await send('Runtime.callFunctionOn', { objectId: arrId, functionDeclaration: action, awaitPromise: true, returnByValue: true });
if (call.result?.exceptionDetails) { console.log('ACTION ERROR:', JSON.stringify(call.result.exceptionDetails).slice(0, 600)); }
console.log('RESULT:', JSON.stringify(call.result?.result?.value, null, 2));
ws.close();
process.exit(0);
