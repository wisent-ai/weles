// The keeper transport: one command per socket connection, and the navigation, read,
// click, fill, key and form commands the repairs are built from.
import net from 'node:net';
import { SOCK } from './settings.mjs';

export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function send(cmd, timeoutMs = 180000) {
  return await new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK);
    let done = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.destroy();
      reject(new Error(`keeper command timed out: ${cmd.action}`));
    }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify(cmd) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      const res = JSON.parse(buf.slice(0, nl));
      if (!res.ok) reject(new Error(`${cmd.action} failed: ${res.error}`));
      else resolve(res);
    });
    conn.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function ro(js) {
  return (await send({ action: 'eval', js })).result;
}

export async function nav(url) {
  const out = await send({ action: 'nav', url }, 180000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  return out;
}

export async function kclick(selector) {
  await send({ action: 'click', selector }, 120000);
  await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
}

export async function kfill(selector, text) {
  await send({ action: 'fill', selector, text }, 240000);
  await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
}

export async function press(key) {
  await send({ action: 'press', key }, 60000);
  await send({ action: 'humanidle', kind: 'short' }, 60000).catch(() => null);
}

export function hasText(text) {
  return JSON.stringify(text);
}

export async function visibleButtons() {
  return await ro(`Array.from(document.querySelectorAll('button')).map((b,i)=>{const r=b.getBoundingClientRect();return {i,text:b.innerText.trim(),disabled:b.disabled,visible:r.width>0&&r.height>0&&getComputedStyle(b).visibility!=='hidden'&&getComputedStyle(b).display!=='none',x:r.left+r.width/2,y:r.top+r.height/2};}).filter(b=>b.visible)`);
}

export async function clickLastButton(label, { requireEnabled = true } = {}) {
  const buttons = (await visibleButtons()).filter((b) => b.text === label && (!requireEnabled || !b.disabled));
  if (!buttons.length) return false;
  const b = buttons[buttons.length - 1];
  await send({ action: 'humanclick', x: b.x, y: b.y }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  return true;
}

export async function saveOpenForm() {
  const buttons = (await visibleButtons()).filter((b) => b.text === 'Zapisz');
  const enabled = buttons.filter((b) => !b.disabled);
  if (!enabled.length) {
    const snapshot = await readVisibleFields();
    await clickLastButton('Anuluj', { requireEnabled: false }).catch(() => null);
    return { status: 'no_enabled_save', buttons, snapshot };
  }
  const b = enabled[enabled.length - 1];
  await send({ action: 'humanclick', x: b.x, y: b.y }, 120000);
  await send({ action: 'humanidle', kind: 'long' }, 60000).catch(() => null);
  await sleep(500);
  return { status: 'saved' };
}

export async function readVisibleFields() {
  return await ro(`Array.from(document.querySelectorAll('input,textarea')).map((el)=>{const r=el.getBoundingClientRect();const id=el.id||'';const label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]')?.textContent?.trim():'';return {tag:el.tagName,type:el.getAttribute('type'),name:el.getAttribute('name'),label,value:(el.value||'').slice(0,300),len:(el.value||'').length,readOnly:!!el.readOnly,disabled:!!el.disabled,visible:r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'};}).filter(x=>x.visible&&x.name)`);
}
