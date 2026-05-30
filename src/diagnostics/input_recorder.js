// Input event recorder for human-vs-trajectory diffing. Reuses the stealth
// core property_trap.js installs under Symbol.for('weles.inst') — so it shares
// the same hidden log array AND the same native-toString cloaking (the value
// setter it installs reports native source via api.makeNative). Uses
// api.origAddEL (the real addEventListener captured before the trap wrap) so
// its own listener registrations don't pollute the addEventListener trap log.
(function(){
  const api = globalThis[Symbol.for('weles.inst')];
  if (!api || api._inputInstalled) return;
  api._inputInstalled = true;
  const logs = api.logs;
  const makeNative = api.makeNative;
  const _origAddEL = api.origAddEL || EventTarget.prototype.addEventListener;
  function recI(type, fields) {
    let vs = '';
    try { vs = JSON.stringify(fields).slice(0, 200); } catch {}
    logs.push({ t: performance.now(), o: 'Input', p: type, vt: 'object', vs, s: '' });
    if (logs.length > 20000) logs.shift();
  }
  let lastMove = 0;
  const SAMPLE_MOVE_MS = 50;
  _origAddEL.call(document, 'pointermove', function(ev) {
    const now = performance.now();
    if (now - lastMove < SAMPLE_MOVE_MS) return;
    lastMove = now;
    recI('pointermove', { x: ev.clientX, y: ev.clientY });
  }, { capture: true, passive: true });
  const CLICKS = 'pointerdown|pointerup|click|dblclick|contextmenu'.split('|');
  CLICKS.forEach(function(t) {
    _origAddEL.call(document, t, function(ev) {
      recI(t, { x: ev.clientX, y: ev.clientY, btn: ev.button, tag: (ev.target && ev.target.tagName) || '' });
    }, { capture: true, passive: true });
  });
  const KEYS = 'keydown|keyup'.split('|');
  KEYS.forEach(function(t) {
    _origAddEL.call(document, t, function(ev) {
      const k = ev.key || '';
      recI(t, { key: (k.length === 1 ? '_' : k), code: ev.code, mod: (ev.shiftKey?'S':'')+(ev.ctrlKey?'C':'')+(ev.metaKey?'M':'')+(ev.altKey?'A':'') });
    }, { capture: true, passive: true });
  });
  _origAddEL.call(document, 'wheel', function(ev) { recI('wheel', { dy: ev.deltaY, dx: ev.deltaX }); }, { capture: true, passive: true });
  _origAddEL.call(window, 'scroll', function() { recI('scroll', { sy: window.scrollY, sx: window.scrollX }); }, { capture: true, passive: true });
  _origAddEL.call(document, 'visibilitychange', function() { recI('visibilitychange', { s: document.visibilityState }); }, { capture: true, passive: true });
  _origAddEL.call(window, 'focus', function() { recI('focus', {}); }, { capture: true, passive: true });
  _origAddEL.call(window, 'blur', function() { recI('blur', {}); }, { capture: true, passive: true });
  // input.value setter hook — every programmatic OR keyboard-driven write is
  // recorded with target id/name/type + new value. Routed through makeNative so
  // the replacement setter reports the original's native source under toString.
  function hookValueSetter(proto, label) {
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!d || !d.set || !d.get) return;
    var newSet = makeNative(function(v) {
      try { recI(label + '_value_set', { id: this.id, name: this.name, type: this.type, tag: this.tagName, val: String(v).slice(0, 200) }); } catch (e) {}
      return d.set.call(this, v);
    }, d.set);
    Object.defineProperty(proto, 'value', { configurable: true, enumerable: d.enumerable, get: d.get, set: newSet });
  }
  try { hookValueSetter(HTMLInputElement.prototype, 'input'); } catch (e) {}
  try { hookValueSetter(HTMLTextAreaElement.prototype, 'textarea'); } catch (e) {}
  // Capture-phase 'input' event: fires AFTER every keystroke or autocomplete
  // selection mutates the input. Records cumulative input.value.
  _origAddEL.call(document, 'input', function(ev) {
    var t = ev.target; if (!t) return;
    var tag = t.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
    recI('input_event', { id: t.id, name: t.name, type: t.type, val: String(t.value).slice(0, 200), isTrusted: ev.isTrusted });
  }, { capture: true, passive: true });
})();
