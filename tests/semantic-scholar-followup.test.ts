import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractSemanticScholarKeyCandidates, runSemanticScholarKeyFollowup } from '../src/secrets/semantic-scholar-followup.js';

const baseEnv = { ...process.env };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  process.env = { ...baseEnv };
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.RESEND_RECEIVING_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_FOLLOWUP_MAX_PAGES;
  delete process.env.SEMANTIC_SCHOLAR_FOLLOWUP_MAX_ATTEMPTS;
  delete process.env.ACTION_LOG_ID;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...baseEnv };
});

describe('Semantic Scholar follow-up scanner', () => {
  it('extracts key-like values only from API-key context and ignores prose tracking identifiers', () => {
    const apiKeyCandidate = 'S2FAKEKEY_0123456789abcdefABCDEF12';
    const envKeyCandidate = 'S2ENVKEY_abcdefghijklmno123456789XYZ';
    const trackingReference = 'TRACKINGREF0123456789ABCDEFGHIJKLMNOP';

    expect(extractSemanticScholarKeyCandidates(`
      Semantic Scholar approved the request.
      Your API key is ${apiKeyCandidate}
      SEMANTIC_SCHOLAR_API_KEY=${envKeyCandidate}
    `)).toEqual([apiKeyCandidate, envKeyCandidate]);

    expect(extractSemanticScholarKeyCandidates(`
      Semantic Scholar application received. Reference ${trackingReference}.
      Use this tracking token when contacting support about the request.
    `)).toEqual([]);
  });

  it('scans the generated mailbox recipient and queues a future follow-up without returning raw email or token content', async () => {
    process.env.SUPABASE_URL = 'https://supabase.example.test/';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    process.env.RESEND_RECEIVING_API_KEY = 'resend-receiving-test-key';
    const sourceActionLogId = 'semantic-source-run-1';
    const targetEmail = 'semantic-applicant@example.test';
    const otherEmail = 'other-applicant@example.test';
    const trackingReference = 'TRACKINGREF0123456789ABCDEFGHIJKLMNOP';
    const requests: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      const urlString = String(url);
      requests.push({ url: urlString, init, body });

      if (urlString.includes(`/rest/v1/account_action_logs?id=eq.${sourceActionLogId}`)) {
        return jsonResponse([{
          id: sourceActionLogId,
          status: 'completed',
          completed_at: '2026-07-03T10:00:00.000Z',
          params: {
            constraints: {
              secret: 'semantic_scholar.api_key',
              purpose: 'lem',
            },
          },
          result: {
            identity: {
              email: targetEmail,
            },
            generic_browser_task: {
              value: {
                status: 'submitted',
                confirmation: 'Semantic Scholar API request submitted.',
                next_steps: 'Semantic Scholar will send the key by email after review.',
              },
            },
          },
        }]);
      }
      if (urlString === 'https://api.resend.com/emails/receiving?limit=100') {
        expect(init?.headers).toEqual({ Authorization: 'Bearer resend-receiving-test-key' });
        return jsonResponse({
          data: [
            {
              id: 'non-target-email',
              to: [otherEmail],
              subject: 'Semantic Scholar update',
              created_at: '2026-07-03T10:05:00.000Z',
            },
            {
              id: 'target-email-without-key',
              to: [{ email: targetEmail }],
              subject: 'Semantic Scholar request received',
              created_at: '2026-07-03T10:06:00.000Z',
            },
          ],
          has_more: false,
        });
      }
      if (urlString === 'https://api.resend.com/emails/receiving/target-email-without-key') {
        expect(init?.headers).toEqual({ Authorization: 'Bearer resend-receiving-test-key' });
        return jsonResponse({
          id: 'target-email-without-key',
          subject: 'Semantic Scholar request received',
          text: `Semantic Scholar application received. Reference ${trackingReference}. Use this tracking token when contacting support.`,
          html: `<p>Semantic Scholar application received. Reference <strong>${trackingReference}</strong>.</p>`,
        });
      }
      if (urlString.includes('/rest/v1/account_action_logs?action=eq.semanticscholar_key_followup')) return jsonResponse([]);
      if (urlString.includes('/rest/v1/account_action_logs?select=id')) return jsonResponse([{ id: 'queued-followup-1' }], 201);
      throw new Error(`unexpected fetch ${urlString}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const beforeRun = Date.now();
    const result = await runSemanticScholarKeyFollowup(sourceActionLogId, 0);

    expect(result).toMatchObject({
      status: 'pending',
      validated: false,
      reason: 'no Semantic Scholar key email found yet',
      source_action_log_id: sourceActionLogId,
      emails_scanned: 2,
      matched_emails: 1,
    });
    if (result.status !== 'pending') return;
    expect(result.next_scheduled_at).toEqual(expect.any(String));
    expect(Date.parse(result.next_scheduled_at ?? '')).toBeGreaterThan(beforeRun);
    expect(requests.map((request) => request.url)).toEqual([
      `https://supabase.example.test/rest/v1/account_action_logs?id=eq.${sourceActionLogId}&select=id,status,started_at,completed_at,params,result&limit=1`,
      'https://api.resend.com/emails/receiving?limit=100',
      'https://api.resend.com/emails/receiving/target-email-without-key',
      'https://supabase.example.test/rest/v1/account_action_logs?action=eq.semanticscholar_key_followup&status=in.(queued,running)&select=id,params&limit=50',
      'https://supabase.example.test/rest/v1/account_action_logs?select=id',
    ]);
    expect(requests.some((request) => request.url.includes('api.semanticscholar.org'))).toBe(false);
    expect(requests.some((request) => request.url.includes('/rest/v1/service_credentials'))).toBe(false);

    const followupInsert = requests[4];
    expect(followupInsert.init?.method).toBe('POST');
    expect(followupInsert.body).toMatchObject({
      action: 'semanticscholar_key_followup',
      platform: 'semanticscholar',
      status: 'queued',
      priority: 25,
      queued_by: 'secret-acquisition-followup',
      params: {
        source_action_log_id: sourceActionLogId,
        attempt: 1,
        secret: 'semantic_scholar.api_key',
        purpose: 'lem',
      },
    });
    expect(Date.parse(String(followupInsert.body?.scheduled_at))).toBeGreaterThan(beforeRun);

    const serializedResult = JSON.stringify(result);
    const serializedInsert = JSON.stringify(followupInsert.body);
    expect(serializedResult).not.toContain(targetEmail);
    expect(serializedResult).not.toContain(trackingReference);
    expect(serializedInsert).not.toContain(targetEmail);
    expect(serializedInsert).not.toContain(trackingReference);
  });
});
