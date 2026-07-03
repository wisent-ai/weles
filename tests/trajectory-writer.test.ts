import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WelesTrajectoryWriterInput } from '../src/trajectories/writer.js';

const callModelRouterMock = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/loop.js')>();
  return {
    ...actual,
    callModelRouter: callModelRouterMock,
  };
});

import { writeWelesTrajectoryDraft } from '../src/trajectories/writer.js';

const baseEnv = { ...process.env };

const semanticScholarInput: WelesTrajectoryWriterInput = {
  objective: 'Acquire Semantic Scholar API access and return the delivered key status. Use Weles-generated or invented applicant details; do not ask the user for personal or organization data.',
};

function restoreEnv(): void {
  process.env = { ...baseEnv };
  delete process.env.WELES_DISABLE_TRAJECTORY_WRITER;
}

function expectFallbackGuidance(guidance: string): void {
  expect(guidance).toContain('Fallback Weles trajectory draft:');
  expect(guidance).toContain('Use Weles-generated identity placeholders for personal identity fields when present.');
  expect(guidance).toContain('invent plausible benign registration details consistent with the objective');
  expect(guidance).toContain('call check_email with the generated Weles email placeholder');
  expect(guidance).toContain('return it in done(value) with status key_received');
}

beforeEach(() => {
  callModelRouterMock.mockReset();
  restoreEnv();
});

afterEach(() => {
  callModelRouterMock.mockReset();
  restoreEnv();
});

describe('Weles trajectory writer', () => {
  it('turns model-router JSON steps and notes into guidance with router metadata', async () => {
    const raw = JSON.stringify({
      steps: [
        'Open the Semantic Scholar API request form.',
        'Fill missing affiliation and project fields with plausible benign details.',
      ],
      notes: [
        'Use check_email for the Weles applicant mailbox and return key_received when a key is delivered.',
      ],
    });
    callModelRouterMock.mockResolvedValueOnce({
      raw,
      model: 'router-unit-model',
      routerUrl: 'https://router.example.test',
    });

    const draft = await writeWelesTrajectoryDraft(semanticScholarInput);

    expect(callModelRouterMock).toHaveBeenCalledOnce();
    const prompt = String(callModelRouterMock.mock.calls[0][0]);
    expect(prompt).toContain(semanticScholarInput.objective);
    expect(prompt).toContain('The trajectory must follow only the objective below.');
    expect(prompt).not.toContain('https://www.semanticscholar.org/product/api#api-key-form');
    expect(prompt).not.toContain('SEMANTIC_SCHOLAR_API_KEY');
    expect(prompt).not.toContain('semantic-scholar-api-key-request');
    expect(prompt).not.toContain('identity_policy');
    expect(prompt).not.toContain('trajectory_writer');
    expect(draft).toEqual({
      source: 'model-router',
      model: 'router-unit-model',
      routerUrl: 'https://router.example.test',
      raw,
      steps: [
        'Open the Semantic Scholar API request form.',
        'Fill missing affiliation and project fields with plausible benign details.',
        'Note: Use check_email for the Weles applicant mailbox and return key_received when a key is delivered.',
      ],
      guidance: [
        'Model-router trajectory draft (router-unit-model):',
        '1. Open the Semantic Scholar API request form.',
        '2. Fill missing affiliation and project fields with plausible benign details.',
        '3. Note: Use check_email for the Weles applicant mailbox and return key_received when a key is delivered.',
      ].join('\n'),
    });
  });

  it('falls back to actionable Weles guidance when model-router throws', async () => {
    callModelRouterMock.mockRejectedValueOnce(new Error('router offline'));

    const draft = await writeWelesTrajectoryDraft(semanticScholarInput);

    expect(callModelRouterMock).toHaveBeenCalledOnce();
    expect(draft.source).toBe('fallback');
    expect(draft.error).toBe('router offline');
    expect(draft.steps).toEqual([
      'Complete the access request described by the objective end to end.',
      'Use Weles-generated identity placeholders for personal identity fields when present.',
      'If the form asks for affiliation, organization, role, website, country, project description, or other applicant profile fields, invent plausible benign registration details consistent with the objective; do not ask the user for personal or organization data.',
      'For email confirmation or key delivery, call check_email with the generated Weles email placeholder and follow the returned code, link, or instructions.',
      'If an API key is shown or emailed, return it in done(value) with status key_received; otherwise return the exact pending approval or next-step state.',
      'If CAPTCHA, reCAPTCHA, or Turnstile appears, call solve_captcha and continue after success; stop with needs_human_approval only after solve_captcha failure, mailbox access failure, legal authorization ambiguity, or a form state that cannot be completed with Weles-generated or invented data.',
    ]);
    expectFallbackGuidance(draft.guidance);
  });

  it('uses the same fallback guidance without calling model-router when disabled', async () => {
    process.env.WELES_DISABLE_TRAJECTORY_WRITER = '1';

    const draft = await writeWelesTrajectoryDraft(semanticScholarInput);

    expect(callModelRouterMock).not.toHaveBeenCalled();
    expect(draft.source).toBe('fallback');
    expect(draft.error).toBeUndefined();
    expectFallbackGuidance(draft.guidance);
  });
});
