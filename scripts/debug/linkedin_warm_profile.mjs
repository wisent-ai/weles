import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PROFILE = join(homedir(), '.weles', 'profiles', 'linkedin_register_warm_decodo_us');
const PROFILE_DIR = process.env.WELES_USER_DATA_DIR || process.env.LINKEDIN_WARM_PROFILE_DIR || DEFAULT_PROFILE;
const LIVE_INIT = process.env.LINKEDIN_WARM_INIT_BROWSER === '1';
const LIVE_TOUCH_LINKEDIN = process.env.LINKEDIN_WARM_TOUCH_LINKEDIN === '1';
const DEFAULT_AGE_DAYS = Number(process.env.LINKEDIN_WARM_AGE_DAYS || 21);

const OUT_DIR = join(process.cwd(), 'recordings', 'linkedin_profile_warmup');
mkdirSync(OUT_DIR, { recursive: true });
const OUT = join(OUT_DIR, `warmup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const BENIGN_HISTORY = [
  ['https://www.google.com/', 'Google', 8, 5],
  ['https://www.google.com/search?q=weather+new+york', 'weather new york - Google Search', 3, 2],
  ['https://www.wikipedia.org/', 'Wikipedia', 5, 1],
  ['https://en.wikipedia.org/wiki/New_York_City', 'New York City - Wikipedia', 4, 0],
  ['https://www.britannica.com/place/New-York-City', 'New York City | Britannica', 2, 0],
  ['https://news.google.com/home?hl=en-US&gl=US&ceid=US:en', 'Google News', 3, 1],
  ['https://www.nytimes.com/', 'The New York Times', 2, 0],
  ['https://www.reuters.com/', 'Reuters', 2, 0],
  ['https://www.youtube.com/', 'YouTube', 3, 1],
  ['https://mail.google.com/', 'Gmail', 2, 1],
  ['https://www.linkedin.com/', 'LinkedIn', 2, 1],
  ['https://www.linkedin.com/login/', 'LinkedIn Login', 1, 0],
  ['https://www.linkedin.com/signup', 'Sign Up | LinkedIn', 1, 0],
];

function chromeTime(ms = Date.now()) {
  return (BigInt(ms) + 11644473600000n) * 1000n;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function profileStats(dir) {
  const def = join(dir, 'Default');
  const statFile = (p) => statSync(p, { throwIfNoEntry: false });
  const count = (p) => {
    try { return readdirSync(p).length; } catch { return 0; }
  };
  return {
    profile_dir: dir,
    root_entry_count: count(dir),
    default_entry_count: count(def),
    local_state_exists: !!statFile(join(dir, 'Local State'))?.isFile(),
    preferences_exists: !!statFile(join(def, 'Preferences'))?.isFile(),
    bookmarks_exists: !!statFile(join(def, 'Bookmarks'))?.isFile(),
    history_exists: !!statFile(join(def, 'History'))?.isFile(),
    cache_exists: !!statFile(join(def, 'Cache'))?.isDirectory(),
    code_cache_exists: !!statFile(join(def, 'Code Cache'))?.isDirectory(),
    created_ms: statFile(dir)?.birthtimeMs ?? null,
    modified_ms: statFile(dir)?.mtimeMs ?? null,
  };
}

async function initializeProfileIfNeeded() {
  const history = join(PROFILE_DIR, 'Default', 'History');
  if (existsSync(history) && !LIVE_INIT) return { initialized: false, reason: 'history_exists' };
  if (!LIVE_INIT && !existsSync(history)) {
    return { initialized: false, reason: 'history_missing_set_LINKEDIN_WARM_INIT_BROWSER_1' };
  }
  process.env.WELES_USER_DATA_DIR = PROFILE_DIR;
  process.env.WELES_DISABLE_RECORDING ??= '1';
  process.env.WELES_FULL_DIAGNOSTICS ??= '0';
  const { WSession } = await import('../../dist/index.js');
  const s = await WSession.start({
    label: 'linkedin_profile_init',
    proxy: 'none',
    targetHost: 'www.linkedin.com',
    browser: process.env.WELES_REGISTER_BROWSER || 'chromium',
    os: process.env.WELES_REGISTER_OS || undefined,
    record: false,
    pageDiagnostics: false,
    userDataDir: PROFILE_DIR,
  });
  try {
    await s.page.goto('about:blank');
    if (LIVE_TOUCH_LINKEDIN) {
      await s.page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await s.page.waitForTimeout(2000).catch(() => {});
    }
  } finally {
    await s.close().catch(() => {});
  }
  return { initialized: true, reason: 'browser_init' };
}

function seedPreferences() {
  const prefPath = join(PROFILE_DIR, 'Default', 'Preferences');
  if (!existsSync(prefPath)) return { ok: false, reason: 'preferences_missing' };
  const prefs = JSON.parse(readFileSync(prefPath, 'utf8'));
  prefs.browser = {
    ...(prefs.browser ?? {}),
    has_seen_welcome_page: true,
    check_default_browser: false,
  };
  prefs.profile = {
    ...(prefs.profile ?? {}),
    avatar_index: prefs.profile?.avatar_index ?? 26,
    name: prefs.profile?.name ?? 'Person 1',
  };
  prefs.bookmark = {
    ...(prefs.bookmark ?? {}),
    editor_expanded_nodes: ['1'],
  };
  prefs.default_search_provider = {
    ...(prefs.default_search_provider ?? {}),
    enabled: true,
  };
  prefs.intl = {
    ...(prefs.intl ?? {}),
    selected_languages: prefs.intl?.selected_languages || 'en-US,en',
  };
  writeFileSync(prefPath, JSON.stringify(prefs));
  return { ok: true };
}

function seedBookmarks() {
  const bookmarkPath = join(PROFILE_DIR, 'Default', 'Bookmarks');
  const now = String(chromeTime());
  const mk = (name, url, daysAgo, id) => ({
    date_added: String(chromeTime(Date.now() - daysAgo * 86_400_000)),
    guid: randomUUID(),
    id: String(id),
    name,
    type: 'url',
    url,
  });
  const bookmarks = {
    checksum: '',
    roots: {
      bookmark_bar: {
        children: [
          mk('News', 'https://news.google.com/home?hl=en-US&gl=US&ceid=US:en', 18, 5),
          mk('Wikipedia', 'https://www.wikipedia.org/', 15, 6),
          mk('LinkedIn', 'https://www.linkedin.com/', 9, 7),
        ],
        date_added: now,
        date_last_used: '0',
        date_modified: now,
        guid: randomUUID(),
        id: '1',
        name: 'Bookmarks bar',
        type: 'folder',
      },
      other: { children: [], date_added: now, date_last_used: '0', date_modified: '0', guid: randomUUID(), id: '2', name: 'Other bookmarks', type: 'folder' },
      synced: { children: [], date_added: now, date_last_used: '0', date_modified: '0', guid: randomUUID(), id: '3', name: 'Mobile bookmarks', type: 'folder' },
    },
    version: 1,
  };
  writeFileSync(bookmarkPath, JSON.stringify(bookmarks, null, 2));
  return { ok: true, count: bookmarks.roots.bookmark_bar.children.length };
}

function seedHistory() {
  const db = join(PROFILE_DIR, 'Default', 'History');
  if (!existsSync(db)) return { ok: false, reason: 'history_missing' };
  const statements = ['PRAGMA journal_mode=WAL;', 'BEGIN;'];
  const seededUrls = BENIGN_HISTORY.map(([url]) => sqlString(url)).join(',');
  statements.push(`DELETE FROM visits WHERE url IN (SELECT id FROM urls WHERE url IN (${seededUrls}));`);
  statements.push(`DELETE FROM keyword_search_terms WHERE url_id IN (SELECT id FROM urls WHERE url IN (${seededUrls}));`);
  statements.push(`DELETE FROM urls WHERE url IN (${seededUrls});`);
  BENIGN_HISTORY.forEach(([url, title, visits, typed], i) => {
    const baseMs = Date.now() - (DEFAULT_AGE_DAYS - i) * 86_400_000;
    const last = String(chromeTime(baseMs));
    statements.push(`
      INSERT INTO urls(url,title,visit_count,typed_count,last_visit_time,hidden)
      SELECT ${sqlString(url)}, ${sqlString(title)}, ${Number(visits)}, ${Number(typed)}, ${last}, 0
      WHERE NOT EXISTS (SELECT 1 FROM urls WHERE url=${sqlString(url)});
      UPDATE urls
      SET title=${sqlString(title)},
          visit_count=max(visit_count, ${Number(visits)}),
          typed_count=max(typed_count, ${Number(typed)}),
          last_visit_time=max(last_visit_time, ${last}),
          hidden=0
      WHERE url=${sqlString(url)};
    `);
    for (let j = 0; j < Number(visits); j++) {
      const t = String(chromeTime(baseMs + j * 3_600_000 + i * 97_000));
      const transition = j === 0 && Number(typed) > 0 ? 805306368 : 268435456;
      statements.push(`
        INSERT INTO visits(url,visit_time,from_visit,transition,visit_duration,consider_for_ntp_most_visited)
        SELECT id, ${t}, 0, ${transition}, ${30_000_000 + j * 5_000_000}, 1 FROM urls WHERE url=${sqlString(url)};
      `);
    }
  });
  statements.push('COMMIT;');
  execFileSync('sqlite3', [db], { input: statements.join('\n') });
  const totals = execFileSync('sqlite3', [db, 'select count(*) from urls; select count(*) from visits;'], { encoding: 'utf8' }).trim().split('\n');
  return { ok: true, urls: Number(totals[0] || 0), visits: Number(totals[1] || 0) };
}

mkdirSync(join(PROFILE_DIR, 'Default'), { recursive: true });
const before = profileStats(PROFILE_DIR);
const init = await initializeProfileIfNeeded();
const pref = seedPreferences();
const bookmarks = seedBookmarks();
const history = seedHistory();
const after = profileStats(PROFILE_DIR);

const summary = {
  started_at: new Date().toISOString(),
  mode: 'synthetic_profile_aging',
  profile_dir: PROFILE_DIR,
  age_days: DEFAULT_AGE_DAYS,
  live_init: LIVE_INIT,
  live_touch_linkedin: LIVE_TOUCH_LINKEDIN,
  init,
  before,
  seed: { preferences: pref, bookmarks, history },
  after,
};
writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(`[warm-profile] mode=synthetic profile=${PROFILE_DIR}`);
console.log(`[warm-profile] init=${init.reason} history=${history.ok ? `${history.urls} urls/${history.visits} visits` : history.reason}`);
console.log(`[warm-profile] wrote ${OUT}`);
