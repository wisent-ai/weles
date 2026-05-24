// Input event recorder for human-vs-trajectory diffing. Extracted from
// property_trap.js to free space for canvas/audio/window-flag hooks.
// Pushes into the global __inst array property_trap installs so
// __inst_flush() picks events up alongside the property-access log.
// Uses window._inst_orig_add_el (stashed by property_trap) to bypass our
// own addEventListener wrap so listener registrations don't pollute the
// addEventListener trap log.
(function(){
  if (!window.__inst || window.__inst_input_installed) return;
  window.__inst_input_installed = true;
  const logs = window.__inst;
  const _origAddEL = window._inst_orig_add_el || EventTarget.prototype.addEventListener;
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
})();
