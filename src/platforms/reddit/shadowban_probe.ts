/**
 * Multi-vantage Reddit shadowban probe.
 *
 * Background: Reddit's edge tier has documented false positives where
 * /user/<u>/about.json returns 404 for a healthy account when the request
 * routes through certain residential proxy IPs (see src/trajectories/
 * reddit/health.mjs and DETECTION_ANTIPATTERNS.md). A single about.json
 * 404 is therefore unreliable as a shadowban verdict.
 *
 * This probe spreads N independent fetches across N fresh proxy sticky
 * sessions (no cookies), each via a freshly-launched WSession. The
 * verdict is by majority vote:
 *   - 2+ vantages return 404                 -> 'shadowbanned'
 *   - 1+ vantages return 200 with valid body -> 'healthy'
 *   - mix or all 403/429/timeout             -> 'indeterminate'
 *
 * Used by:
 *   - src/trajectories/reddit/shadowban_check.mjs (standalone trajectory)
 *   - src/trajectories/reddit/organic_comment.mjs (post-submit verify)
 *   - src/trajectories/reddit_comment.mjs (post-submit verify)
 */

import { WSession } from '../../session/wsession.js';
import { resolveProxy } from '../../proxy/config.js';

export type ShadowbanVerdict = 'shadowbanned' | 'healthy' | 'indeterminate';

export interface VantageResult {
  vantage: number;
  status: number;
  has_body: boolean;
  exit_ip?: string;
  err?: string;
}

export interface MultiVantageProbeResult {
  verdict: ShadowbanVerdict;
  username: string;
  vantages: VantageResult[];
  ts: string;
}

/**
 * Probe https://old.reddit.com/user/<username>/about.json from N independent
 * fresh sessions, each with no cookies and a freshly-rolled sticky proxy
 * session. Returns the per-vantage results plus an aggregate verdict.
 *
 * @param username  the reddit username to probe (case-sensitive — pass the
 *                  real handle from /api/me.json, not our stored email-prefix
 *                  username, which Reddit auto-replaces during signup).
 * @param vantages  number of independent vantages to use (default 3).
 *                  Each vantage spins up a separate Chromium so this is
 *                  expensive — keep small.
 */
export async function probeShadowban(
  username: string,
  vantages = 3,
): Promise<MultiVantageProbeResult> {
  const results: VantageResult[] = [];
  const url = `https://old.reddit.com/user/${encodeURIComponent(username)}/about.json`;

  for (let i = 0; i < vantages; i++) {
    let session: WSession | null = null;
    try {
      // Fresh proxy with a fresh sticky session id. resolveProxy() rolls
      // a new sessId each call (see config.ts:213) so each vantage exits
      // through a different residential IP. No account-cookie restoration
      // — this is the "logged-out" view of the user.
      const pw = await resolveProxy('residential us', 'www.reddit.com')
        .catch(() => undefined);
      const proxyUrl = pw?.server
        ? `${pw.server.replace(/^http(s?):\/\//, 'http$1://')}`
        : undefined;
      // Build the auth-embedded URL for WSession.start.
      const proxyForSession = pw?.server && pw.username && pw.password
        ? `${pw.server.replace('://', `://${encodeURIComponent(pw.username)}:${encodeURIComponent(pw.password)}@`)}`
        : proxyUrl;

      session = await WSession.start({
        label: `reddit_shadowban_probe_v${i + 1}`,
        proxy: proxyForSession,
      });

      const resp = await session.page.context().request.get(url, {
        headers: {
          'Accept': 'application/json',
          // Plain UA — about.json sometimes 403s for bare-fetch UAs but the
          // session UA inherits the persona.
        },
        ignoreHTTPSErrors: true,
        timeout: 15000,
      }).catch((e: any) => ({ _err: e?.message?.slice(0, 120) ?? 'fetch_error', status: () => 0, text: async () => '' }));

      const status = typeof (resp as any).status === 'function' ? (resp as any).status() : 0;
      let body = '';
      try { body = typeof (resp as any).text === 'function' ? await (resp as any).text() : ''; } catch { /* skip */ }
      let hasBody = false;
      try {
        const j = JSON.parse(body);
        hasBody = typeof j?.data?.name === 'string' && j.data.name.length > 0;
      } catch { /* not JSON */ }
      results.push({ vantage: i + 1, status, has_body: hasBody, exit_ip: pw?.exit_ip, err: (resp as any)._err });
    } catch (e: any) {
      results.push({ vantage: i + 1, status: 0, has_body: false, err: e?.message?.slice(0, 120) ?? 'launch_error' });
    } finally {
      if (session) await session.close().catch(() => {});
    }
  }

  // Tally
  const four_oh_four = results.filter(r => r.status === 404).length;
  const ok = results.filter(r => r.status === 200 && r.has_body).length;

  let verdict: ShadowbanVerdict;
  if (ok >= 1) verdict = 'healthy';
  else if (four_oh_four >= 2) verdict = 'shadowbanned';
  else verdict = 'indeterminate';

  return { verdict, username, vantages: results, ts: new Date().toISOString() };
}

/**
 * Single-vantage permalink-JSON visibility check. Used by the deferred
 * post-submit verify path: after the comment was submitted, wait T seconds,
 * then re-fetch the comment's permalink JSON via a fresh proxy with no
 * cookies, and confirm the comment node is present.
 *
 * Returns true if the comment is publicly visible from a clean session,
 * false if it's missing (auto-removed or shadowbanned).
 */
export async function probeCommentVisibility(opts: {
  postPermalinkBase: string; // e.g. 'https://old.reddit.com/r/sub/comments/abc/post-slug'
  commentId: string;          // base36 id, e.g. 'oj0vwon'
  expectedAuthor?: string;    // optional sanity check
}): Promise<{ visible: boolean; status: number; exit_ip?: string; err?: string }> {
  const { postPermalinkBase, commentId, expectedAuthor } = opts;
  const url = `${postPermalinkBase.replace(/\/$/, '')}/${commentId}/.json`;

  let session: WSession | null = null;
  try {
    const pw = await resolveProxy('residential us', 'old.reddit.com').catch(() => undefined);
    const proxyForSession = pw?.server && pw.username && pw.password
      ? `${pw.server.replace('://', `://${encodeURIComponent(pw.username)}:${encodeURIComponent(pw.password)}@`)}`
      : pw?.server;
    session = await WSession.start({
      label: 'reddit_visibility_probe',
      proxy: proxyForSession,
    });
    const resp = await session.page.context().request.get(url, {
      headers: { 'Accept': 'application/json' },
      ignoreHTTPSErrors: true,
      timeout: 15000,
    });
    const status = resp.status();
    const body = await resp.text().catch(() => '');
    let visible = false;
    try {
      const j = JSON.parse(body);
      const node = j?.[1]?.data?.children?.[0];
      visible = node?.kind === 't1'
        && node?.data?.id === commentId
        && (!expectedAuthor || node?.data?.author === expectedAuthor);
    } catch { /* not JSON */ }
    return { visible, status, exit_ip: pw?.exit_ip };
  } catch (e: any) {
    return { visible: false, status: 0, err: e?.message?.slice(0, 120) ?? 'probe_error' };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}
