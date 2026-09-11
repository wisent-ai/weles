// Reading what the History UI shows about the phrase.


export async function summarizeVisible(page, queryText) {
  return await page.evaluate((queryText) => {
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const texts = [];
    const addText = (label, value) => {
      const text = String(value || '');
      if (text.length < 20) return;
      if (texts.some((entry) => entry.text === text)) return;
      texts.push({ label, text });
    };
    const addDoc = (label, doc) => {
      if (!doc) return;
      try {
        if (typeof doc === 'string') addText(label, doc);
        else if (typeof doc.toString === 'function') addText(label, doc.toString());
        else if (typeof doc.getValue === 'function') addText(label, doc.getValue());
      } catch {
        // Ignore inaccessible editor internals.
      }
    };
    const seenObjects = new Set();
    const inspectObject = (obj, label, depth = 0) => {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      if (seenObjects.has(obj) || depth > 3) return;
      seenObjects.add(obj);
      try { if (typeof obj.getValue === 'function') addText(`${label}.getValue`, obj.getValue()); } catch {}
      try { addDoc(`${label}.state.doc`, obj.state?.doc); } catch {}
      try { addDoc(`${label}.view.state.doc`, obj.view?.state?.doc); } catch {}
      try { if (typeof obj.doc?.getValue === 'function') addText(`${label}.doc.getValue`, obj.doc.getValue()); } catch {}
      try { if (typeof obj.cm?.getValue === 'function') addText(`${label}.cm.getValue`, obj.cm.getValue()); } catch {}
      for (const key of ['view', 'editor', 'sourceEditor', '_editor', 'cm', 'codeMirror', 'doc', 'state', 'model']) {
        try { inspectObject(obj[key], `${label}.${key}`, depth + 1); } catch {}
      }
    };
    const inspectDomEditorState = () => {
      const selectors = [
        '.cm-editor',
        '.cm-content',
        '.cm-scroller',
        '.CodeMirror',
        '.CodeMirror-code',
        '[class*="cm-"]',
        '[class*="CodeMirror"]',
      ];
      for (const el of Array.from(document.querySelectorAll(selectors.join(',')))) {
        inspectObject(el, `dom.${el.className || el.tagName}`);
        try {
          for (const key of Reflect.ownKeys(el)) {
            const value = el[key];
            inspectObject(value, `dom.${String(key)}`);
          }
        } catch {
          // Some browser objects reject property enumeration.
        }
      }
    };
    const inspectKnownGlobals = () => {
      for (const key of ['_ide', 'ide', 'editor', 'editorManager', 'angular', 'webpackChunkoverleaf']) {
        try { inspectObject(window[key], `window.${key}`); } catch {}
      }
      try {
        const current = window._ide?.editorManager?.getCurrentEditor?.();
        inspectObject(current, 'window._ide.editorManager.getCurrentEditor');
      } catch {}
      try {
        const current = window.ide?.editorManager?.getCurrentEditor?.();
        inspectObject(current, 'window.ide.editorManager.getCurrentEditor');
      } catch {}
    };
    const tokenizeWithOffsets = (s) => {
      const out = [];
      const re = /[A-Za-z0-9]+/g;
      let m;
      while ((m = re.exec(String(s || '')))) {
        out.push({ token: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
      }
      return out;
    };
    const bestTokenWindow = (body, wanted) => {
      const targetTokens = tokenizeWithOffsets(wanted).map((t) => t.token);
      const bodyTokens = tokenizeWithOffsets(body);
      if (targetTokens.length < 3 || bodyTokens.length < targetTokens.length) return null;
      let best = null;
      for (let i = 0; i <= bodyTokens.length - targetTokens.length; i += 1) {
        let hits = 0;
        for (let j = 0; j < targetTokens.length; j += 1) {
          if (bodyTokens[i + j].token === targetTokens[j]) hits += 1;
        }
        const score = hits / targetTokens.length;
        if (!best || score > best.score) {
          best = { score, start: bodyTokens[i].start, end: bodyTokens[i + targetTokens.length - 1].end, hits };
        }
      }
      const threshold = targetTokens.length >= 10 ? 0.82 : 0.9;
      return best && best.score >= threshold ? best : null;
    };
    const bestDocumentText = () => {
      const looksLikeLatex = (text) =>
        /\\documentclass|\\begin\{document\}|\\title\{|\\section\{|\\subsection\{|\\paragraph\{/.test(text);
      const docs = texts
        .filter((entry) => entry.text.length >= 500 && looksLikeLatex(entry.text))
        .sort((left, right) => right.text.length - left.text.length);
      return docs[0] || null;
    };
    const wanted = normalize(queryText);
    const body = document.body.innerText || '';
    const rawBody = document.documentElement.textContent || '';
    inspectDomEditorState();
    inspectKnownGlobals();
    const candidates = [];
    for (const el of Array.from(document.querySelectorAll('button,a,[role="button"],li,div'))) {
      const text = normalize(el.textContent || '');
      if (!text || text.length < 3 || text.length > 500) continue;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      candidates.push(text);
      if (candidates.length >= 120) break;
    }
    const editorText = texts.map((entry) => entry.text).join('\n\n');
    const documentText = bestDocumentText();
    const nbody = normalize([body, rawBody, editorText].filter(Boolean).join(' '));
    const idx = wanted ? nbody.indexOf(wanted) : -1;
    const fuzzy = idx >= 0 ? null : bestTokenWindow(nbody, wanted);
    const targetIndex = idx >= 0 ? idx : (fuzzy ? fuzzy.start : -1);
    const targetEnd = idx >= 0 ? idx + wanted.length : (fuzzy ? fuzzy.end : -1);
    return {
      title: document.title,
      url: location.href,
      targetIndex,
      targetMatchKind: idx >= 0 ? 'exact' : (fuzzy ? 'token_window' : 'none'),
      targetScore: idx >= 0 ? 1 : (fuzzy?.score ?? 0),
      targetContext: targetIndex >= 0 ? nbody.slice(Math.max(0, targetIndex - 500), targetEnd + 500) : null,
      documentText: documentText?.text ?? null,
      documentTextSource: documentText?.label ?? null,
      documentTextLength: documentText?.text.length ?? 0,
      editorTextSources: texts.map((entry) => ({ label: entry.label, length: entry.text.length })).slice(0, 20),
      visibleItems: Array.from(new Set(candidates)).slice(0, 80),
      bodyHead: nbody.slice(0, 3000),
    };
  }, queryText);
}
