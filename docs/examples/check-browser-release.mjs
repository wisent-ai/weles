#!/usr/bin/env node
// Show the fail-closed browser selection from dist/session/find_browser.js.
// findCustomBrowser returns a path ONLY when the exact release env vars are
// set AND the installed binary carries a verification receipt matching the
// immutable Stado coordinate + checksum. Anything less returns undefined.
//
// Usage: node docs/examples/check-browser-release.mjs
// Runs offline; the second call uses a synthetic release, never a download.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { findCustomBrowser, customBrowserSearchHint } = await import(`${repo}/dist/session/find_browser.js`);

console.log('1) unconfigured environment (no release env vars):');
delete process.env.WELES_CHROMIUM_RELEASE_VERSION;
delete process.env.WELES_CHROMIUM_RELEASE_SHA256;
console.log('   findCustomBrowser(\'chromium\') ->', findCustomBrowser('chromium'));
console.log('   hint:', customBrowserSearchHint('chromium'));

console.log('\n2) release configured but never installed/verified (synthetic coordinate):');
process.env.WELES_CHROMIUM_RELEASE_VERSION = '0.0.0-docs-example';
process.env.WELES_CHROMIUM_RELEASE_SHA256 = 'a'.repeat(64);
console.log('   findCustomBrowser(\'chromium\') ->', findCustomBrowser('chromium'));
console.log('   hint:', customBrowserSearchHint('chromium'));

console.log('\n3) unknown browser family:');
console.log('   hint:', customBrowserSearchHint('netscape'));
