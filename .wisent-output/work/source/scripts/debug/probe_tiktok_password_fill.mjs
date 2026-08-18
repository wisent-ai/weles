#!/usr/bin/env node
// Reproduce the password-fill failure: navigate to signup, advance to email
// tab, select birthday, fill email + password the same way the trajectory
// does, then dump the DOM state at each step.

import { WSession } from '../../dist/session/wsession.js';
import { generatePersona } from '../../dist/browser/persona.js';

const s = await WSession.start({ label: 'probe_pw_fill', proxy: process.env.PROXY_URL || 'residential', persona: generatePersona({ country: 'US', browser: 'chromium' }) });
const dump = async (label) => {
  const r = await s.page.evaluate(`(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    return inputs.filter(i => {
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && i.offsetParent !== null;
    }).map(i => ({
      type: i.getAttribute('type'),
      placeholder: i.getAttribute('placeholder'),
      valueLen: (i.value || '').length,
      value: (i.value || '').slice(0, 20),
      focused: document.activeElement === i,
    }));
  })()`).catch((e) => ({ error: e.message }));
  console.log(`[${label}] ${JSON.stringify(r)}`);
};

try {
  await s.goto('https://www.tiktok.com/signup');
  await s.wait(5);
  await s.click('Use phone or email');
  await s.wait(2);
  await s.click('Sign up with email');
  await s.wait(3);

  await s.select('month', 'June');
  await s.select('day', '15');
  await s.select('year', '1995');
  await s.wait(2);
  await dump('after-bday');

  await s.fill('Email', 'probe_test_5491@example.com');
  await s.wait(1);
  await dump('after-email');

  // Step A: just click password to see if click alone flips type
  console.log('--- step A: humanClickLocator on password input ---');
  const { humanClickLocator } = await import('../../dist/human/mouse.js');
  const pwLoc = s.page.locator('input[type="password"]').first();
  await humanClickLocator(s.page, pwLoc);
  await s.wait(1);
  await dump('after-click-only');

  // Step B: try ControlOrMeta+A + Delete (humanFill's clear step)
  console.log('--- step B: ControlOrMeta+A + Delete ---');
  await s.page.keyboard.press('ControlOrMeta+A').catch(() => {});
  await s.page.keyboard.press('Delete').catch(() => {});
  await s.wait(1);
  await dump('after-clear');

  // Step C: type one char via CDP-routed humanType
  console.log('--- step C: humanType X ---');
  const { humanType } = await import('../../dist/human/keyboard.js');
  await humanType(s.page, 'X');
  await s.wait(1);
  await dump('after-type-X');

  // Step D: try locator.focus() instead of click, then type
  console.log('--- step D: focus() then type ---');
  // Re-resolve the password input — type may have flipped
  const pwLoc2 = s.page.locator('input[placeholder="Password"]').first();
  const pwCount2 = await pwLoc2.count();
  console.log(`[D] input[placeholder=Password] count=${pwCount2}`);
  if (pwCount2) {
    await pwLoc2.focus();
    await s.wait(1);
    await dump('after-focus');
    await humanType(s.page, 'YYY');
    await s.wait(1);
    await dump('after-focus-type');
  }

  // Step E: native locator.fill — bypass keyboard, write via DOM value setter
  console.log('--- step E: locator.fill ---');
  const pwLoc3 = s.page.locator('input[placeholder="Password"]').first();
  await pwLoc3.fill('NativeFillABC123!').catch((e) => console.log('  fill err:', e.message));
  await s.wait(1);
  await dump('after-native-fill');
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200), e.stack?.slice(0, 300));
} finally {
  await s.close();
}
