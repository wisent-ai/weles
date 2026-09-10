// Challenge-outcome classifier. Decodes the reCAPTCHA Enterprise control
// responses (reload / userverify) and the LinkedIn checkpoint flow out of a
// captured HAR into a structured, SQL-queryable verdict — so "what captcha did
// this proxy get, did it pass, and why" is a field, not a manual HAR dig.
//
// Grounded in real captures (4ef1c68e datacenter vs 337b88f3 residential):
//   - reload  body: ["rresp", tok, null, ttl, pmeta, type, ...]
//       type  = "multicaptcha" (hard, multi-object grid) | "dynamic" (single object)
//       pmeta = grid dims + object machine-ids (Knowledge-Graph /m/... codes)
//   - userverify body: ["uvresp", tok, verdict, ttl, ..., <rresp followup when 0>]
//       verdict = 0 -> solve REJECTED, a fresh challenge is inlined (the red
//                      "please try again") ; 1 -> ACCEPTED (ttl, no followup)
//   - LinkedIn POST /checkpoint/challenge/verify -> 303 = challenge accepted,
//     account creation advances. Absent = never got past Google's gauntlet.

// Confirmed reCAPTCHA object classes only (the dynamic challenges echo the text
// label, which matched these). Unknown machine-ids fall through as the raw id
// rather than guess — the map is best-effort, never authoritative.
const MID: Record<string, string> = {
  '/m/0k4j': 'car', '/m/0199g': 'bicycle', '/m/04_sv': 'motorcycle', '/m/01bjv': 'bus',
  '/m/015qff': 'traffic light', '/m/01lynh': 'stairs', '/m/014xcs': 'crosswalk',
  '/m/0pg52': 'taxi', '/m/01mqdt': 'traffic sign', '/m/07j7r': 'tree', '/m/02pv19': 'stop sign',
  '/m/0gv1x': 'parking meter', '/m/0463sg': 'fire hydrant', '/m/0cdl1': 'palm tree',
  '/m/0c9ph5': 'flower', '/m/079cl': 'skyscraper', '/m/0cgh4': 'building',
  '/m/06bt6': 'railroad', '/m/01lcw4': 'limousine', '/m/0h9mv': 'tire',
};
const label = (m: string): string => MID[m] ?? m;

function parseGrc(text: string): any {
  if (!text) return null;
  try { return JSON.parse(text.replace(/^\)\]\}'\n?/, '')); } catch { return null; }
}

export interface ChallengeRound {
  t: string;
  source: 'reload' | 'userverify_followup';
  type: string | null;          // 'multicaptcha' | 'dynamic'
  ttl: number | null;
  grid: string | null;          // '4x4' | '3x3'
  objects: string[];            // resolved labels
  object_mids: string[];        // raw /m/... ids
}

// rresp = ["rresp", token, null, ttl, pmeta, type, ...]
function parseRresp(arr: any): Omit<ChallengeRound, 't' | 'source'> | null {
  if (!Array.isArray(arr) || arr[0] !== 'rresp') return null;
  const type = typeof arr[5] === 'string' ? arr[5] : null;
  const pmeta = arr[4];
  let grid: string | null = null;
  const mids: string[] = [];
  if (Array.isArray(pmeta) && pmeta[0] === 'pmeta') {
    if (type === 'dynamic' && Array.isArray(pmeta[1])) {
      const d = pmeta[1];        // [mid, null, rows, cols, ?, null, labelText]
      if (d[0]) mids.push(d[0]);
      if (typeof d[2] === 'number' && typeof d[3] === 'number') grid = `${d[2]}x${d[3]}`;
    } else if (Array.isArray(pmeta[5])) {
      const seq = Array.isArray(pmeta[5][0]) ? pmeta[5][0] : pmeta[5];   // [[targets]]
      for (const t of seq) {
        if (Array.isArray(t) && t[0]) {
          mids.push(t[0]);
          const r = t[t.length - 2], c = t[t.length - 1];
          if (typeof r === 'number' && typeof c === 'number' && !grid) grid = `${r}x${c}`;
        }
      }
    }
  }
  return { type, ttl: typeof arr[3] === 'number' ? arr[3] : null, grid, objects: mids.map(label), object_mids: mids };
}

// uvresp = ["uvresp", token, verdict, ttl, ..., <rresp followup when verdict 0>]
function parseUvresp(arr: any): { verdict: any; passed: boolean; followup: any } | null {
  if (!Array.isArray(arr) || arr[0] !== 'uvresp') return null;
  const verdict = arr[2];
  const followup = arr.find((x: any, i: number) => i >= 4 && Array.isArray(x) && x[0] === 'rresp');
  return { verdict, passed: verdict === 1, followup: followup ? parseRresp(followup) : null };
}

export interface ChallengeOutcome {
  provider: 'recaptcha_enterprise';
  present: boolean;
  li: { createAccount_challengeUrl: boolean; captchaInternal: boolean; verify_303: boolean };
  challenges: ChallengeRound[];
  solves: Array<{ t: string; verdict: any; passed: boolean }>;
  reload_count: number;
  userverify_count: number;
  image_select_rounds: number;
  summary: {
    types: string[];
    max_grid: string | null;
    distinct_objects: string[];
    solve_attempts: number;
    rejections: number;
    captcha_passed: boolean;
    li_accepted: boolean;
  };
  outcome: 'passed' | 'failed' | 'none';
  outcome_detail: string;
  duration_s?: number;
}

// Accepts HAR entries ({request.url, response.status, response.content.text,
// startedDateTime}). Pure — no IO.
export function analyzeChallengeOutcome(harEntries: any[]): ChallengeOutcome {
  const e = (harEntries ?? [])
    .map((x: any) => ({ url: x?.request?.url ?? '', status: x?.response?.status ?? 0, body: x?.response?.content?.text ?? '', t: x?.startedDateTime ?? '' }))
    .sort((a, b) => a.t.localeCompare(b.t));
  const out: ChallengeOutcome = {
    provider: 'recaptcha_enterprise', present: false,
    li: { createAccount_challengeUrl: false, captchaInternal: false, verify_303: false },
    challenges: [], solves: [], reload_count: 0, userverify_count: 0, image_select_rounds: 0,
    summary: { types: [], max_grid: null, distinct_objects: [], solve_attempts: 0, rejections: 0, captcha_passed: false, li_accepted: false },
    outcome: 'none', outcome_detail: 'no_challenge',
  };
  for (const r of e) {
    if (/signup\/api\/cors\/createAccount/.test(r.url) && /challengeUrl/.test(r.body)) out.li.createAccount_challengeUrl = true;
    if (/checkpoint\/challenge\/captchaInternal/.test(r.url)) { out.li.captchaInternal = true; out.present = true; }
    if (/checkpoint\/challenge\/verify/.test(r.url) && r.status === 303) out.li.verify_303 = true;
    if (/enterprise\/replaceimage/.test(r.url)) out.image_select_rounds++;
    if (/enterprise\/reload/.test(r.url)) {
      out.reload_count++;
      const rr = parseRresp(parseGrc(r.body));
      if (rr && rr.type) { out.present = true; out.challenges.push({ t: r.t.slice(11, 23), source: 'reload', ...rr }); }
    }
    if (/enterprise\/userverify/.test(r.url)) {
      out.userverify_count++;
      const uv = parseUvresp(parseGrc(r.body));
      if (uv) {
        out.solves.push({ t: r.t.slice(11, 23), verdict: uv.verdict, passed: uv.passed });
        if (uv.followup && uv.followup.type) out.challenges.push({ t: r.t.slice(11, 23), source: 'userverify_followup', ...uv.followup });
      }
    }
  }
  const captcha_passed = out.solves.some(s => s.passed);
  out.summary = {
    types: [...new Set(out.challenges.map(c => c.type).filter(Boolean))] as string[],
    max_grid: out.challenges.map(c => c.grid).filter(Boolean).sort().pop() ?? null,
    distinct_objects: [...new Set(out.challenges.flatMap(c => c.objects))],
    solve_attempts: out.solves.length,
    rejections: out.solves.filter(s => s.verdict === 0).length,
    captcha_passed,
    li_accepted: out.li.verify_303,
  };
  out.outcome = !out.present ? 'none' : (captcha_passed && out.li.verify_303) ? 'passed' : 'failed';
  out.outcome_detail = out.outcome === 'passed' ? 'passed_and_li_accepted'
    : !out.present ? 'no_challenge'
      : captcha_passed ? 'captcha_passed_but_li_not_accepted'
        : `not_passed_after_${out.solves.length}_solve_attempts`;
  if (e.length) out.duration_s = Math.round((Date.parse(e[e.length - 1].t) - Date.parse(e[0].t)) / 1000);
  return out;
}
