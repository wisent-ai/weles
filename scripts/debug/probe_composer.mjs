/**
 * Diagnostic: probe shreddit-composer shadow DOM on new-reddit.
 * Opens a post page (with existing account cookies), expands the composer,
 * and dumps everything about its internal structure: shadow children,
 * submit button, event listeners, form action, etc.
 *
 * Usage: node scripts/debug/probe_composer.mjs
 */
import { WSession } from '../../dist/session/wsession.js';
import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { humanIdlePause } from '../../dist/human/mouse.js';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'probe_composer', proxy: proxyUrl, persona });

// Inject saved cookies
const cookies = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});

try {
  // Navigate to a post where the composer should appear
  const TARGET = process.env.TARGET_URL;
  if (TARGET && /\/comments\//.test(TARGET)) {
    await s.page.goto(TARGET, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
  } else {
    await s.page.goto('https://www.reddit.com/r/CasualConversation/', { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
    const postLink = s.page.locator('a[href*="/comments/"]').filter({ visible: true }).first();
    if (!(await postLink.count())) { console.log('no posts found'); process.exit(1); }
    await postLink.click();
    await s.page.waitForLoadState('domcontentloaded');
    await humanIdlePause('deliberate');
  }

  console.log(`page: ${s.page.url()}`);

  // Wait for shreddit-composer to mount
  for (let i = 0; i < 5; i++) {
    const has = await s.page.evaluate(() => !!document.querySelector('shreddit-composer'));
    if (has) break;
    console.log(`retry ${i+1}: no shreddit-composer, reloading`);
    await s.page.reload({ waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
  }

  // Expand the composer
  await s.page.evaluate(() => {
    const sc = document.querySelector('shreddit-composer');
    if (sc) sc.scrollIntoView({ block: 'center', behavior: 'instant' });
    document.dispatchEvent(new CustomEvent('open-comment-composer', { bubbles: true, composed: true }));
  });
  await humanIdlePause('deliberate');

  if (process.env.CLICK_JOIN === '1') {
    const join = s.page.getByRole('button', { name: /^join$/i }).filter({ visible: true }).first();
    if (await join.count()) {
      console.log('CLICK_JOIN: clicking visible Join button');
      await join.click();
      await humanIdlePause('deliberate');
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await humanIdlePause('deliberate');
    } else {
      console.log('CLICK_JOIN: no visible Join button');
    }
  }

  // Full shadow DOM dump
  const dump = await s.page.evaluate(() => {
    function walkShadow(root, depth = 0) {
      const result = [];
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        const entry = {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80) || undefined,
          role: el.getAttribute('role') || undefined,
          type: el.getAttribute('type') || undefined,
          name: el.getAttribute('name') || undefined,
          ce: el.isContentEditable || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          textContent: (el.textContent || '').slice(0, 40).trim() || undefined,
          size: `${Math.round(r.width)}x${Math.round(r.height)}`,
          visible: r.width > 0 && r.height > 0,
          depth,
        };
        // Clean undefined
        for (const k of Object.keys(entry)) { if (entry[k] === undefined) delete entry[k]; }
        result.push(entry);
        if (el.shadowRoot) {
          result.push({ tag: `#shadow-root`, depth: depth + 1 });
          result.push(...walkShadow(el.shadowRoot, depth + 1));
        }
      }
      return result;
    }

    const sc = document.querySelector('shreddit-composer');
    if (!sc) return { error: 'no shreddit-composer' };

    function ancestors(el) {
      const out = [];
      let cur = el;
      while (cur && out.length < 10) {
        const r = cur.getBoundingClientRect?.();
        const cs = cur.nodeType === Node.ELEMENT_NODE ? getComputedStyle(cur) : null;
        out.push({
          tag: cur.tagName?.toLowerCase?.(),
          cls: cur.className?.toString?.()?.slice(0, 100),
          id: cur.id || '',
          size: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : '',
          display: cs?.display || '',
          visibility: cs?.visibility || '',
          overflow: cs?.overflow || '',
        });
        cur = cur.parentElement;
      }
      return out;
    }

    const scR = sc.getBoundingClientRect();
    const scInfo = {
      tag: 'shreddit-composer',
      size: `${Math.round(scR.width)}x${Math.round(scR.height)}`,
      visible: scR.width > 0,
      attrs: {
        placeholder: sc.getAttribute('placeholder'),
        postType: sc.getAttribute('post-type'),
        rtl: sc.getAttribute('rtl'),
      },
      ancestors: ancestors(sc),
    };

    // Walk light DOM children of shreddit-composer
    const lightChildren = [];
    for (const el of sc.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      lightChildren.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        visible: r.width > 0,
      });
    }

    // Walk shadow DOM
    const shadowTree = sc.shadowRoot ? walkShadow(sc.shadowRoot, 0) : [];

    // Find any forms / buttons
    const forms = [];
    const buttons = [];
    function findElements(root) {
      for (const el of root.querySelectorAll('form, button, a[role="button"], [type="submit"]')) {
        const r = el.getBoundingClientRect();
        const entry = {
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
          type: el.getAttribute('type') || '',
          action: el.getAttribute('action') || '',
          method: el.getAttribute('method') || '',
          text: (el.textContent || '').trim().slice(0, 30),
          size: `${Math.round(r.width)}x${Math.round(r.height)}`,
          visible: r.width > 0,
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        };
        if (el.tagName.toLowerCase() === 'form') forms.push(entry);
        else buttons.push(entry);
      }
      // Recurse into shadow roots
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) findElements(el.shadowRoot);
      }
    }
    findElements(document);

    // Check what events the composer handles
    const eventInfo = [];
    if (sc.shadowRoot) {
      // Can't directly read event listeners from JS, but we can check
      // for common attribute-based handlers
      const shadowHost = sc.shadowRoot.host;
      eventInfo.push({
        hasOpenEvent: true, // we dispatched it
      });
    }

    return { scInfo, lightChildren: lightChildren.slice(0, 20), shadowTree: shadowTree.slice(0, 60), forms, buttons };
  });

  console.log('\n=== SHREDDIT-COMPOSER STRUCTURE ===');
  console.log(JSON.stringify(dump.scInfo, null, 2));
  console.log('\n=== LIGHT CHILDREN ===');
  for (const c of dump.lightChildren) console.log(`  ${c.tag}.${(c.cls||'').split(' ')[0]} ${c.size} vis=${c.visible}`);
  console.log('\n=== SHADOW TREE (first 60) ===');
  for (const c of dump.shadowTree) {
    const indent = '  '.repeat(c.depth || 0);
    if (c.tag === '#shadow-root') { console.log(`${indent}#shadow-root`); continue; }
    const parts = [c.tag];
    if (c.cls) parts.push(`.${c.cls.split(' ')[0]}`);
    if (c.ce) parts.push('[contenteditable]');
    if (c.role) parts.push(`role=${c.role}`);
    if (c.type) parts.push(`type=${c.type}`);
    if (c.name) parts.push(`name=${c.name}`);
    if (c.placeholder) parts.push(`ph="${c.placeholder}"`);
    if (c.textContent) parts.push(`text="${c.textContent}"`);
    parts.push(c.size);
    if (c.visible !== undefined) parts.push(`vis=${c.visible}`);
    console.log(`${indent}${parts.join(' ')}`);
  }
  console.log('\n=== FORMS ===');
  for (const f of dump.forms) console.log(`  ${f.tag} action=${f.action} method=${f.method} ${f.size} vis=${f.visible}`);
  console.log('\n=== BUTTONS ===');
  for (const b of dump.buttons) console.log(`  ${b.tag}.${(b.cls||'').split(' ')[0]} type=${b.type} text="${b.text}" ${b.size} vis=${b.visible} disabled=${b.disabled}`);

  // Try typing something and looking for the submit button to become enabled
  console.log('\n=== TYPING TEST ===');
  const probe2 = await s.page.evaluate(() => {
    const sc = document.querySelector('shreddit-composer');
    if (!sc?.shadowRoot) return { error: 'no shadow root' };

    // Find the contenteditable
    function dig(root) {
      for (const el of root.querySelectorAll('*')) {
        if (el.isContentEditable && el.getBoundingClientRect().width > 50) return el;
        if (el.shadowRoot) { const r = dig(el.shadowRoot); if (r) return r; }
      }
      return null;
    }
    const ce = dig(sc.shadowRoot);
    if (!ce) return { error: 'no contenteditable found' };
    ce.focus();
    ce.textContent = 'test probe text';

    // Now search for submit buttons
    const btns = [];
    function findBtns(root) {
      for (const el of root.querySelectorAll('button, [role="button"], [type="submit"], a.submit')) {
        const r = el.getBoundingClientRect();
        btns.push({
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
          type: el.getAttribute('type') || '',
          text: (el.textContent || '').trim().slice(0, 30),
          size: `${Math.round(r.width)}x${Math.round(r.height)}`,
          visible: r.width > 0,
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          ariaLabel: el.getAttribute('aria-label') || '',
        });
        if (el.shadowRoot) findBtns(el.shadowRoot);
      }
    }
    findBtns(sc.shadowRoot);
    findBtns(document);

    // Also check for faceplate-form submit
    const ff = sc.closest('faceplate-form') || sc.parentElement?.closest('faceplate-form');
    const ffInfo = ff ? {
      tag: ff.tagName.toLowerCase(),
      action: ff.getAttribute('action') || '',
      method: ff.getAttribute('method') || '',
      size: `${Math.round(ff.getBoundingClientRect().width)}x${Math.round(ff.getBoundingClientRect().height)}`,
    } : null;

    return { btns, faceplateForm: ffInfo, ceTag: ce.tagName, ceSize: `${Math.round(ce.getBoundingClientRect().width)}x${Math.round(ce.getBoundingClientRect().height)}` };
  });
  console.log(JSON.stringify(probe2, null, 2));

} catch (e) {
  console.log('ERROR:', e.message);
} finally {
  await s.close();
}
