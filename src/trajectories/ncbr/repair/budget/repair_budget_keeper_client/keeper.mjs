// The keeper transport: one command per socket connection, and the navigation, read,
// click, fill, key and form commands the repairs are built from.
import { keeperRequest } from '../../../../_shared/keeper/client.mjs';
import { SOCK } from './settings.mjs';

export async function send(cmd) {
  const res = await keeperRequest(SOCK, cmd);
  if (!res.ok) throw new Error(`${cmd.action} failed: ${res.error}`);
  return res;
}

export async function ro(js) {
  return (await send({ action: 'eval', js })).result;
}

export async function nav(url) {
  const out = await send({ action: 'nav', url });
  await send({ action: 'settle' });
  return out;
}

export async function kclick(selector) {
  await send({ action: 'click', selector });
  await send({ action: 'settle' });
}

export async function kfill(selector, text) {
  await send({ action: 'fill', selector, text });
  await send({ action: 'settle' });
}

export async function press(key) {
  await send({ action: 'press', key });
  await send({ action: 'settle' });
}

export function hasText(text) {
  return JSON.stringify(text);
}

export async function visibleButtons() {
  return await ro(
    `Array.from(document.querySelectorAll('button')).map((b,i)=>{const r=b.getBoundingClientRect();return {i,text:b.innerText.trim(),disabled:b.disabled,visible:r.width>0&&r.height>0&&getComputedStyle(b).visibility!=='hidden'&&getComputedStyle(b).display!=='none',x:r.left+r.width/2,y:r.top+r.height/2};}).filter(b=>b.visible)`,
  );
}

export async function clickLastButton(label, { requireEnabled = true } = {}) {
  const buttons = (await visibleButtons()).filter(
    (b) => b.text === label && (!requireEnabled || !b.disabled),
  );
  if (!buttons.length) return false;
  const b = buttons[buttons.length - 1];
  await send({ action: 'humanclick', x: b.x, y: b.y });
  await send({ action: 'settle' });
  return true;
}

export async function saveOpenForm() {
  const buttons = (await visibleButtons()).filter((b) => b.text === 'Zapisz');
  const enabled = buttons.filter((b) => !b.disabled);
  if (!enabled.length) {
    const snapshot = await readVisibleFields();
    await clickLastButton('Anuluj', { requireEnabled: false }).catch(
      () => null,
    );
    return { status: 'no_enabled_save', buttons, snapshot };
  }
  const b = enabled[enabled.length - 1];
  await send({ action: 'humanclick', x: b.x, y: b.y });
  await send({ action: 'settle' });
  return { status: 'saved' };
}

export async function readVisibleFields() {
  return await ro(
    `Array.from(document.querySelectorAll('input,textarea')).map((el)=>{const r=el.getBoundingClientRect();const id=el.id||'';const label=id?document.querySelector('label[for="'+CSS.escape(id)+'"]')?.textContent?.trim():'';return {tag:el.tagName,type:el.getAttribute('type'),name:el.getAttribute('name'),label,value:(el.value||'').slice(0,300),len:(el.value||'').length,readOnly:!!el.readOnly,disabled:!!el.disabled,visible:r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none'};}).filter(x=>x.visible&&x.name)`,
  );
}
