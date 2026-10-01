import { pageSettled } from '../../_shared/page/settled.mjs';
import { completeMultimodal } from './stado_model_router.mjs';
// In-browser Arkose audio puzzle solver for GitHub FunCaptcha.
// Ports the core flow from account-api-build/skills/creators/_github_audio.py.
// Strategy: inject audio capture hooks, click Audio puzzle, read each target
// sound, capture the played buffer, classify it through the authenticated Stado
// model router, and click the numbered answer. Loops until solved or max rounds.

const AUDIO_HOOK_SCRIPT = `(() => {
  if (window.__audioHooked) return;
  window.__audioHooked = true;
  window.__playedAudio = [];
  window.__playIdx = 0;
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    const s = this.currentSrc || this.src || '';
    const idx = window.__playIdx++;
    window.__playedAudio.push({ i: idx, src: s.slice(0, 200), t: Date.now() });
    if (s.startsWith('blob:')) {
      fetch(s).then(r => r.blob()).then(b => {
        const rd = new FileReader();
        rd.onload = () => window.__playedAudio.push({ i: idx, type: b.type || 'audio/mpeg', size: b.size, b64: rd.result.split(',')[1], src: 'blob' });
        rd.readAsDataURL(b);
      }).catch(() => {});
    }
    return origPlay.call(this);
  };
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...a) {
    if (this.buffer && this.buffer.length > 500) {
      try {
        const ch = this.buffer.getChannelData(0), sr = this.buffer.sampleRate, dl = ch.length * 2;
        const b = new ArrayBuffer(44 + dl), d = new DataView(b);
        const w = (o, s) => { for (let j = 0; j < s.length; j++) d.setUint8(o + j, s.charCodeAt(j)); };
        w(0, 'RIFF'); d.setUint32(4, 36 + dl, true); w(8, 'WAVE'); w(12, 'fmt ');
        d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
        d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true);
        d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, dl, true);
        let o = 44;
        for (let j = 0; j < ch.length; j++) { const s = Math.max(-1, Math.min(1, ch[j])); d.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
        const u = new Uint8Array(b), c = [];
        for (let j = 0; j < u.length; j += 8192) c.push(String.fromCharCode.apply(null, u.subarray(j, j + 8192)));
        window.__playedAudio.push({ i: window.__playIdx++, type: 'audio/wav', size: b.byteLength, b64: btoa(c.join('')), src: 'bufStart', dur: ch.length / sr });
      } catch (e) { window.__playedAudio.push({ err: e.message, src: 'bufStart' }); }
    }
    return origStart.apply(this, a);
  };
  const origCU = URL.createObjectURL;
  URL.createObjectURL = function(bl) {
    const u = origCU.call(URL, bl);
    if (bl instanceof Blob && (bl.type.startsWith('audio/') || bl.size > 30000)) {
      const rd = new FileReader();
      rd.onload = () => window.__playedAudio.push({ type: bl.type, size: bl.size, b64: rd.result.split(',')[1], src: 'objURL' });
      rd.readAsDataURL(bl);
    }
    return u;
  };
})()`;

// The Arkose enforcement frame, once it has rendered buttons, images or text.
// It may attach after this call, so frame attachment is awaited as an event.
async function getGameFrame(page) {
  const isEnforcement = (f) => /arkoselabs\.com.*enforcement.*\.html/.test(f.url());
  const enforcement = page.frames().find(isEnforcement)
    ?? await page.waitForEvent('framenavigated', { predicate: isEnforcement });
  await enforcement.waitForFunction(
    () => document.querySelectorAll('button').length > 0 || document.querySelectorAll('img,canvas').length > 0 || (document.body?.innerText ?? '').length > 20,
    undefined,
    { polling: 'raf' },
  );
  return enforcement;
}

async function classifyAudio(b64, mime, targetSound, numOptions) {
  const prompt = `This is an audio captcha with ${numOptions} sound clips played one after another, numbered 1 to ${numOptions}. Ignore any spoken instruction at the start ("Press the number for the sound of X"). Which option number is the real sound of '${targetSound}'? Some options may be HUMANS imitating the target (e.g. a person saying meow) — those are WRONG; only pick the real sound. Format: 'Sound 1: [description], Sound 2: ..., Answer: [number]'`;
  const { text, model } = await completeMultimodal({
    base64: b64,
    mimeType: mime,
    prompt,
  });
  const match = text.match(/Answer\s*[:\s=]\s*(\d+)/i) ?? text.match(/(\d+)\s*$/);
  const answer = Number(match?.at(1));
  if (!Number.isInteger(answer) || answer < 1 || answer > numOptions) {
    throw new Error(`model-router returned no valid audio option: ${text}`);
  }
  console.log(`[audio] Stado model-router (${model}): ${text}`);
  return answer;
}

export async function solveAudioPuzzle(page, { maxRounds = 10 } = {}) {
  await page.evaluate(AUDIO_HOOK_SCRIPT).catch(() => {});
  const frame = await getGameFrame(page);
  if (!frame) { console.log('[audio] No Arkose game frame found'); return false; }
  console.log(`[audio] Game frame: ${frame.url().slice(0, 100)}`);
  await frame.evaluate(AUDIO_HOOK_SCRIPT).catch(() => {});

  // The puzzle UI renders its buttons in the game frame; read them once the
  // frame has settled.
  await pageSettled(frame);
  const inventory = await frame.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(b => b.offsetParent !== null);
    return btns.map(b => ({ text: b.innerText?.trim().slice(0, 40), aria: b.getAttribute('aria-label')?.slice(0, 40), cls: b.className?.slice(0, 60) }));
  })()`);
  const audioMatch = inventory.find(b => /audio|sound|accessibility/i.test((b.text || '') + ' ' + (b.aria || '')));
  if (!audioMatch) { console.log(`[audio] No Audio button on the settled puzzle — buttons(${inventory.length}): ${JSON.stringify(inventory.slice(0, 8))}`); return false; }
  console.log(`[audio] Found audio-like button: ${JSON.stringify(audioMatch)}`);
  const audioBtn = frame.locator(`button:has-text("${audioMatch.text}"), [aria-label="${audioMatch.aria}"]`).first();
  await audioBtn.click();
  console.log('[audio] Clicked Audio puzzle');
  await pageSettled(frame);

  for (let round = 1; round <= maxRounds; round++) {
    const info = await frame.evaluate(`(() => {
      const text = document.body?.innerText ?? '';
      const buttons = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null).map(b => b.innerText.trim().slice(0, 30));
      const nums = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => b.offsetParent !== null && /^\\d+$/.test(b.innerText.trim())).map(b => b.innerText.trim());
      return { text: text.slice(0, 600), buttons, numOptions: nums.length };
    })()`).catch(() => null);
    if (!info) { console.log(`[audio] Round ${round}: frame eval failed`); break; }
    console.log(`[audio] R${round}: ${info.text.slice(0, 150).replace(/\n/g, ' ')}`);

    if (/complete|success|solved|verified/i.test(info.text)) { console.log('[audio] Success text detected'); return true; }
    if (/blocked|try again|failed/i.test(info.text)) { console.log('[audio] Blocked'); return false; }

    const targetMatch = info.text.match(/sound of (.+?)[?\n.]/i);
    if (!targetMatch) { console.log(`[audio] R${round}: no target in text — assuming done`); break; }
    const target = targetMatch[1].trim().toLowerCase();
    console.log(`[audio] R${round} target: "${target}", ${info.numOptions} options`);

    const playBtn = frame.locator('button:has-text("Play"), button[aria-label*="play" i]').first();
    if (await playBtn.isVisible().catch(() => false)) {
      await playBtn.click().catch(() => {});
      console.log(`[audio] R${round}: Play clicked`);
    }
    // The hook records each clip as it plays; wait until one is captured in
    // any frame, then take the biggest from that frame.
    const capturedIn = await Promise.any(page.frames().map((f) => f.waitForFunction(
      () => (window.__playedAudio || []).some((a) => a.b64 && a.b64.length > 1000),
      undefined,
      { polling: 'raf' },
    ).then(() => f)));
    let b64 = null, mime = 'audio/wav';
    const clips = await capturedIn.evaluate(`(() => (window.__playedAudio || []).filter(a => a.b64 && a.b64.length > 1000))()`);
    if (clips?.length) {
      const biggest = clips.reduce((m, c) => (c.size ?? c.b64.length) > (m.size ?? m.b64.length) ? c : m);
      b64 = biggest.b64; mime = biggest.type || 'audio/wav';
      console.log(`[audio] R${round}: captured ${clips.length} clips, biggest=${biggest.size ?? biggest.b64.length}b`);
    }
    if (!b64) {
      console.log(`[audio] R${round}: no audio captured; refusing to guess`);
      return false;
    }

    let pick;
    try {
      pick = await classifyAudio(b64, mime, target, info.numOptions || Number('6'));
    } catch (error) {
      console.log(`[audio] R${round}: Stado model-router failed: ${String(error?.message || error).slice(Number(false), Number('160'))}`);
      return false;
    }
    console.log(`[audio] R${round}: picking option ${pick}`);

    const clicked = await frame.evaluate(`(n => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => b.offsetParent !== null);
      for (const b of buttons) {
        const t = b.innerText.trim();
        if (t === String(n) || new RegExp('^' + n + '\\\\b').test(t)) { b.click(); return { clicked: true, text: t.slice(0, 30) }; }
      }
      return { clicked: false };
    })(${pick})`).catch(e => ({ err: e.message }));
    console.log(`[audio] R${round}: click=${JSON.stringify(clicked)}`);

    // Clear captured audio for next round
    for (const f of page.frames()) {
      await f.evaluate('window.__playedAudio = []').catch(() => {});
    }
    await pageSettled(frame);
  }
  return false;
}
