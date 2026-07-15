import { homedir } from 'node:os';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const MAX_VAULT_BYTES = 16 * 1024 * 1024;
const RELEASE_TAG = 'skarbiec-vault-latest';

type ReleaseAsset = {
  name?: string;
};

type ReleaseResponse = {
  id?: number;
  assets?: ReleaseAsset[];
};

async function checkedOwnerFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const link = await lstat(path);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`${label} must be a regular, non-symlink file`);
  const metadata = await stat(path);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
  return realpath(path);
}

async function githubToken(): Promise<string> {
  const configured = process.env.SKARBIEC_CRED_FILE?.trim() || join(homedir(), '.git-credentials-weles');
  const credentialFile = await checkedOwnerFile(configured, 'SKARBIEC_CRED_FILE');
  const firstLine = (await readFile(credentialFile, 'utf8')).split(/\r?\n/, 1)[0]?.trim() ?? '';
  let parsed: URL;
  try {
    parsed = new URL(firstLine);
  } catch {
    throw new Error('SKARBIEC_CRED_FILE does not contain a credential URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.password) {
    throw new Error('SKARBIEC_CRED_FILE does not contain a GitHub HTTPS token');
  }
  return parsed.password;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'weles-skarbiec-vault-publisher',
  };
}

export async function publishReturnedSkarbiecVault(requestId: string): Promise<void> {
  if (process.env.SKARBIEC_PUBLISH_VAULT_AFTER_RETURN !== '1') return;
  if (!/^[a-fA-F0-9]{64}$/.test(requestId)) throw new Error('invalid Skarbiec request id for vault publication');
  const configuredVault = process.env.SKARBIEC_VAULT_FILE?.trim() ?? '';
  if (!configuredVault) throw new Error('SKARBIEC_VAULT_FILE is not set');
  const vaultPath = await checkedOwnerFile(configuredVault, 'SKARBIEC_VAULT_FILE');
  const metadata = await stat(vaultPath);
  if (metadata.size < 1 || metadata.size > MAX_VAULT_BYTES) throw new Error('Skarbiec vault size is invalid');
  const repository = process.env.SKARBIEC_WELES_REPO?.trim() || 'wisent-ai/weles';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('SKARBIEC_WELES_REPO is invalid');
  const token = await githubToken();
  const headers = githubHeaders(token);
  const releaseResponse = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${RELEASE_TAG}`, { headers });
  if (!releaseResponse.ok) throw new Error('could not resolve the Skarbiec vault release');
  const release = await releaseResponse.json() as ReleaseResponse;
  if (!Number.isSafeInteger(release.id)) throw new Error('Skarbiec vault release response is invalid');
  const assetName = `skarbiec.vault.${requestId}.json`;
  if (release.assets?.some((asset) => asset.name === assetName)) return;
  const vault = await readFile(vaultPath);
  const upload = await fetch(
    `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(vault.length) },
      body: vault,
    },
  );
  if (!upload.ok) throw new Error('could not publish the returned Skarbiec vault');
}
