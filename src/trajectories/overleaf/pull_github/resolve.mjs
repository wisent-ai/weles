// The candidate projects: the given id, or every dashboard project whose title contains
// the given text.
import { IS_ID, PROJECT, REPO_SLUG } from './settings.mjs';
import { dieUI } from './evidence.mjs';

export async function resolveCandidates(s) {
  let candidates = [];
  if (IS_ID) {
    candidates = [{ id: PROJECT, name: '(by id)' }];
  } else {
    const anchorSel = 'a[href*="/project/"]';
    await s.page.locator(anchorSel).first().waitFor({ state: 'visible' });
    candidates = await s.page.evaluate(({ sel, needle }) => {
      const want = needle.toLowerCase();
      const seen = new Map();
      for (const a of Array.from(document.querySelectorAll(sel))) {
        const hrefAttr = a.getAttribute('href');
        if (hrefAttr === null) continue;
        const m = hrefAttr.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/);
        if (!m) continue;
        const id = m[1];
        const name = a.textContent.trim();
        if (!seen.has(id)) seen.set(id, name);
      }
      const out = [];
      for (const [id, name] of seen.entries()) {
        if (name.toLowerCase().includes(want)) out.push({ id, name });
      }
      return out;
    }, { sel: anchorSel, needle: PROJECT });
    if (candidates.length === 0) {
      await dieUI(s, 'resolve', `no dashboard project title contains "${PROJECT}"`);
    }
    console.log(`[pull_github] ${candidates.length} title match(es); disambiguating by GitHub link to ${REPO_SLUG}`);
  }
  return candidates;
}
