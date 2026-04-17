// Load weles/.env into process.env. Used by login.mjs and scrape.mjs.
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv() {
  try {
    const envFile = path.resolve(new URL('../../../.env', import.meta.url).pathname);
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (e) { /* ignore */ }
}
