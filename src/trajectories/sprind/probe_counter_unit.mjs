// Probe: are SPRIND textarea limits (0/50, 0/500, ...) characters or words?
// Types known probes into the first <textarea> via humanFill and reads
// back the visible counter element. Comparing counter values to known
// char/word counts of each probe disambiguates the unit.
//
// Run:
//   node weles/src/trajectories/sprind/probe_counter_unit.mjs

import { WSession } from '../../../dist/session/wsession.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const URL = 'https://www.sprind.org/taten/challenges/submissions/next-frontier-ai';
const LABEL = 'sprind_counter_probe';

const s = await WSession.start({ label: LABEL, proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  for (let i = 0; i < 30; i++) {
    const ready = await s.page.evaluate(() => !!document.querySelector('textarea'));
    if (ready) break;
    await s.wait(1);
  }
  await s.wait(2);

  const readState = async () => s.page.evaluate(() => {
    // First textarea on the page is the project title (0/50 in labels).
    const ta = document.querySelector('textarea');
    if (!ta) return { error: 'no textarea' };
    const container = ta.closest('.field, .form-field, .w-form-field, [data-name], section, fieldset, div') || ta.parentElement;
    let counterText = '';
    if (container) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.nodeValue || '').trim();
        if (/^\d+\s*\/\s*\d+$/.test(t)) { counterText = t; break; }
      }
    }
    return {
      taValue: ta.value,
      taValueLen: ta.value.length,
      taValueWords: ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0,
      counterText,
    };
  });

  const taLocator = s.page.locator('textarea').first();
  await taLocator.scrollIntoViewIfNeeded();

  console.log('initial:', JSON.stringify(await readState()));

  // Probe A: 5 single-letter words separated by spaces.
  //   chars = 9 ("a b c d e"), words = 5
  await humanFill(s.page, taLocator, 'a b c d e');
  await s.wait(1);
  console.log('probeA (chars=9, words=5):', JSON.stringify(await readState()));

  // Probe B: one contiguous 12-char string, zero whitespace.
  //   chars = 12, words = 1
  await humanFill(s.page, taLocator, 'abcdefghijkl');
  await s.wait(1);
  console.log('probeB (chars=12, words=1):', JSON.stringify(await readState()));

  // Probe C: 3 longer words.
  //   chars = 22 ("foundation models work"), words = 3
  await humanFill(s.page, taLocator, 'foundation models work');
  await s.wait(1);
  console.log('probeC (chars=22, words=3):', JSON.stringify(await readState()));
} finally {
  await s.close();
}
