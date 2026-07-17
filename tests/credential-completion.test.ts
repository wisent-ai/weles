import { describe, expect, it, vi } from 'vitest';
import { finalizeCredentialCompletion, prepareCredentialCompletion } from '../src/worker/credential-completion.js';

const canary = 'brave-canary-private-api-key';

function acquiredResult(): Record<string, unknown> {
  return {
    generic_browser_task: {
      value: {
        status: 'completed',
        api_key: canary,
        confirmation: `issued ${canary}`,
      },
    },
    nested: [{ token: canary }],
  };
}

describe('worker credential completion', () => {
  it('hands plaintext to Skarbiec before redacting every result persistence sink', async () => {
    const original = acquiredResult();
    const transfer = vi.fn(async () => {
      expect(JSON.stringify(original)).toContain(canary);
      return { secretValue: canary, error: null };
    });

    const prepared = await prepareCredentialCompletion(original, transfer);

    expect(transfer).toHaveBeenCalledOnce();
    expect(JSON.stringify(prepared.safeResult)).not.toContain(canary);
    expect(JSON.stringify(prepared.safeResult)).toContain('[redacted]');

    const writeResult = vi.fn(async (_result: Record<string, unknown>) => {});
    const updateTrajectory = vi.fn(async (_result: Record<string, unknown>) => {});
    const sendWebhook = vi.fn(async (_result: Record<string, unknown>) => {});
    const failed = vi.fn(async () => {});
    const status = await finalizeCredentialCompletion(prepared, {
      completed: async (safeResult) => {
        await writeResult(safeResult);
        await updateTrajectory(safeResult);
        await sendWebhook(safeResult);
      },
      failed,
    });

    expect(status).toBe('completed');
    expect(failed).not.toHaveBeenCalled();
    for (const sink of [writeResult, updateTrajectory, sendWebhook]) {
      expect(sink).toHaveBeenCalledOnce();
      expect(JSON.stringify(sink.mock.calls[0]?.[0])).not.toContain(canary);
    }
  });

  it('fails closed with only redacted payloads when Skarbiec rejects the credential', async () => {
    const prepared = await prepareCredentialCompletion(acquiredResult(), async () => ({
      secretValue: canary,
      error: 'Skarbiec credential return failed',
    }));
    const completed = vi.fn(async () => {});
    const failed = vi.fn(async (_result: Record<string, unknown>, _error: string) => {});

    const status = await finalizeCredentialCompletion(prepared, { completed, failed });

    expect(status).toBe('failed');
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
    expect(JSON.stringify(failed.mock.calls[0]?.[0])).not.toContain(canary);
    expect(failed.mock.calls[0]?.[1]).toBe('Skarbiec credential return failed');
  });
});
