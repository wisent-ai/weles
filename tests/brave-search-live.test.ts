import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';

type ProcessResult = {
  code: number;
  stdout: Buffer;
};

function runProcess(
  executable: string,
  arguments_: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: Buffer; allowFailure?: boolean } = {},
): Promise<ProcessResult> {
  const { promise, resolve: resolveProcess, reject } = Promise.withResolvers<ProcessResult>();
  const child = spawn(executable, arguments_, {
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  const maximumOutputBytes = 1_048_576;

  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes) child.kill();
    else stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes) child.kill();
    else stderr.push(chunk);
  });
  child.once('error', () => reject(new Error('could not start live Brave Search test process')));
  child.once('close', (code) => {
    const exitCode = code ?? -1;
    if (exitCode !== 0 && !options.allowFailure) {
      const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 400);
      reject(new Error(detail ? `live Brave Search test process failed: ${detail}` : 'live Brave Search test process failed'));
      return;
    }
    resolveProcess({ code: exitCode, stdout: Buffer.concat(stdout) });
  });
  child.stdin.end(options.stdin);
  return promise;
}

it.skipIf(process.env.RUN_LIVE_BRAVE_CREDENTIAL_TEST !== '1')(
  'autonomously acquires one real Brave Search credential into Skarbiec and validates it against the Brave API',
  async () => {
    const home = homedir();
    const skarbiecCLI = process.env.SKARBIEC_CLI?.trim()
      || resolve('vendor/skarbiec/target/release/skarbiec-entitlements-router');
    const vaultFile = process.env.SKARBIEC_VAULT_FILE?.trim()
      || resolve(home, 'Documents/CodingProjects/Wisent/entitlements-rotator/skarbiec.vault.json');
    const unlockFile = process.env.SKARBIEC_UNLOCK_FILE?.trim() || resolve(home, '.skarbiec-unlock');
    const syncDirectory = process.env.SKARBIEC_SYNC_DIR?.trim() || resolve(home, '.skarbiec-sync');
    const syncRemote = process.env.SKARBIEC_SYNC_REMOTE?.trim()
      || 'https://github.com/lbartoszcze/skarbiec-vault-sync.git';
    await access(skarbiecCLI);
    await access(vaultFile);
    await access(unlockFile);

    let unlock = (await readFile(unlockFile, 'utf8')).trim();
    let token = '';
    const skarbiecEnvironment = {
      ...process.env,
      SKARBIEC_UNLOCK: unlock,
      SKARBIEC_VAULT_FILE: vaultFile,
      SKARBIEC_SYNC_DIR: syncDirectory,
      SKARBIEC_SYNC_REMOTE: syncRemote,
      SKARBIEC_WELES_RECIPIENT: process.env.SKARBIEC_WELES_RECIPIENT?.trim() || 'jeden-release-authority',
    };
    const credentialId = 'BRAVE_SEARCH_API_KEY';
    const requestItemId = `request:credential/${credentialId}`;
    const requestId = randomBytes(32).toString('hex');
    let requestPending = false;

    try {
      await runProcess(skarbiecCLI, ['sync-pull'], { env: skarbiecEnvironment });
      requestPending = true;
      const registration = await runProcess(
        skarbiecCLI,
        [
          'credential-request',
          credentialId,
          '--provider',
          'brave',
          '--consumer',
          'live-brave-search-test',
          '--purpose',
          'content-platform-blog-research',
          '--request-id',
          requestId,
          '--register-only',
        ],
        { env: skarbiecEnvironment },
      );
      const registered = JSON.parse(registration.stdout.toString('utf8')) as {
        status?: string;
        request_id?: string;
      };
      expect(registered.status).toBe('pending');
      expect(registered.request_id).toBe(requestId);
      await runProcess(skarbiecCLI, ['sync-push'], { env: skarbiecEnvironment });

      const request = {
        secret: 'brave.search_api_key',
        purpose: 'content-platform-blog-research',
        skarbiecRequestId: requestId,
        skarbiecCredentialId: credentialId,
        autoPromoteTrajectory: true,
      };
      const acquisition = await runProcess(
        process.execPath,
        [resolve('scripts/secrets/acquire.mjs'), '--stdin-json'],
        { stdin: Buffer.from(JSON.stringify(request), 'utf8') },
      );
      const queued = JSON.parse(acquisition.stdout.toString('utf8')) as {
        status?: string;
        actionLogId?: string;
        vaultItemId?: string;
      };
      expect(queued.status).toBe('acquisition_queued');
      expect(queued.actionLogId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(queued.vaultItemId).toBe(credentialId);

      const completion = await runProcess(
        process.execPath,
        [resolve('scripts/secrets/acquire.mjs'), `--wait-action=${queued.actionLogId}`],
      );
      const completed = JSON.parse(completion.stdout.toString('utf8')) as { status?: string };
      expect(completed.status).toBe('completed');

      await runProcess(skarbiecCLI, ['sync-pull'], { env: skarbiecEnvironment });
      const stored = await runProcess(skarbiecCLI, ['get', credentialId], { env: skarbiecEnvironment });
      const credential = JSON.parse(stored.stdout.toString('utf8')) as {
        value?: string;
        provider?: string;
      };
      requestPending = false;
      token = credential.value?.trim() ?? '';
      expect(token.length).toBeGreaterThan(16);
      expect(credential.provider).toBe('brave');

      const validation = await fetch('https://api.search.brave.com/res/v1/web/search?q=wisent&count=1', {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': token,
        },
        signal: AbortSignal.timeout(30_000),
      });
      expect(validation.ok, `Brave API validation returned HTTP ${validation.status}`).toBe(true);
      await validation.body?.cancel();

      const supabaseURL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      expect(supabaseURL).not.toBe('');
      expect(serviceKey).not.toBe('');
      const actionResponse = await fetch(
        `${supabaseURL}/rest/v1/account_action_logs?id=eq.${encodeURIComponent(queued.actionLogId!)}&select=result`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      );
      expect(actionResponse.ok).toBe(true);
      const actionRows = await actionResponse.json() as Array<{ result?: unknown }>;
      expect(actionRows).toHaveLength(1);
      expect(JSON.stringify(actionRows[0]?.result ?? null)).not.toContain(token);
    } finally {
      if (requestPending) {
        await runProcess(skarbiecCLI, ['sync-pull'], { env: skarbiecEnvironment, allowFailure: true });
        await runProcess(skarbiecCLI, ['delete', requestItemId], { env: skarbiecEnvironment, allowFailure: true });
        await runProcess(skarbiecCLI, ['sync-push'], { env: skarbiecEnvironment, allowFailure: true });
      }
      token = '';
      unlock = '';
      delete skarbiecEnvironment.SKARBIEC_UNLOCK;
    }
  },
  25 * 60 * 1_000,
);
