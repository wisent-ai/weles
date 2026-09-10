import { readFile, stat } from 'node:fs/promises';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const MAX_IMPORT_REQUEST_BYTES = MAX_IMPORT_BYTES + 4 * 1024;
const IMPORT_STATES: Record<string, true> = {
  imported: true,
  unchanged: true,
  refused: true,
};

export type WelesImportItem = {
  source_id: string;
  name: string;
  action: string;
  state: 'imported' | 'unchanged' | 'refused';
  trajectory_id: string | null;
  status: string | null;
  reason: string | null;
};

export type WelesImportReport = {
  schema: 'weles.seed-import.v1';
  ok: true;
  organization_id: string;
  execution_host: string;
  imported: number;
  unchanged: number;
  refused: number;
  items: WelesImportItem[];
};

export type WelesImportClientOptions = {
  endpoint?: string;
  bearer?: string;
  organizationId?: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
};

function requiredConfiguration(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (value !== normalized || CONTROL_RE.test(value)) throw new Error(`${name} contains invalid whitespace or control characters`);
  return normalized;
}

function importEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('WELES_API_BASE must be a URL');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('WELES_API_BASE must not contain credentials, query parameters, or a fragment');
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('WELES_API_BASE must use HTTPS unless it names a loopback host');
  }
  return new URL('/api/v1/imports', endpoint);
}

function parseReport(value: unknown, organizationId: string, targetHost: string): WelesImportReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Weles returned an invalid import result');
  const report = value as Record<string, unknown>;
  if (report.schema !== 'weles.seed-import.v1'
    || report.ok !== true
    || report.organization_id !== organizationId
    || report.execution_host !== targetHost
    || !Number.isInteger(report.imported)
    || !Number.isInteger(report.unchanged)
    || !Number.isInteger(report.refused)
    || Number(report.imported) < 0
    || Number(report.unchanged) < 0
    || Number(report.refused) < 0
    || !Array.isArray(report.items)
    || report.items.length !== Number(report.imported) + Number(report.unchanged) + Number(report.refused)
    || !report.items.every((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const item = value as Record<string, unknown>;
      return typeof item.source_id === 'string'
        && typeof item.name === 'string'
        && typeof item.action === 'string'
        && typeof item.state === 'string'
        && IMPORT_STATES[item.state] === true
        && (item.trajectory_id === null || typeof item.trajectory_id === 'string')
        && (item.status === null || typeof item.status === 'string')
        && (item.reason === null || typeof item.reason === 'string');
    })) {
    throw new Error('Weles returned an unsupported import result');
  }
  return report as WelesImportReport;
}

export async function importWelesTrajectoryDocument(
  source: unknown,
  targetHost: string,
  options: WelesImportClientOptions = {},
): Promise<WelesImportReport> {
  const environment = options.environment ?? process.env;
  const endpoint = importEndpoint(requiredConfiguration(options.endpoint ?? environment.WELES_API_BASE, 'WELES_API_BASE'));
  const bearer = requiredConfiguration(options.bearer ?? environment.WELES_TOKEN, 'WELES_TOKEN');
  const organizationId = requiredConfiguration(
    options.organizationId ?? environment.WISENT_ORGANIZATION_ID,
    'WISENT_ORGANIZATION_ID',
  ).toLowerCase();
  if (!UUID_RE.test(organizationId)) throw new Error('WISENT_ORGANIZATION_ID must be a UUID');
  const host = targetHost.trim().toLowerCase().replace(/\.+$/, '');
  if (!HOST_RE.test(host)) throw new Error('--host must be the exact managed Weles worker hostname');

  let sourceJson: string | undefined;
  try {
    sourceJson = JSON.stringify(source);
  } catch {
    throw new Error('trajectory export must be JSON-serializable');
  }
  if (!sourceJson || sourceJson[0] !== '{') throw new Error('trajectory export must be a JSON object');
  if (Buffer.byteLength(sourceJson, 'utf8') > MAX_IMPORT_BYTES) throw new Error('trajectory export exceeds 2 MiB');
  const requestBody = `{"source":${sourceJson},"target_host":${JSON.stringify(host)}}`;
  if (Buffer.byteLength(requestBody, 'utf8') > MAX_IMPORT_REQUEST_BYTES) throw new Error('trajectory import request exceeds its 2 MiB source limit');

  const response = await (options.fetch ?? fetch)(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      'X-Wisent-Organization-ID': organizationId,
    },
    body: requestBody,
  });
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new Error('Weles import response exceeds 2 MiB');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Weles import endpoint returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    const error = typeof bodyRecord?.error === 'string'
      ? bodyRecord.error
      : `Weles import failed with HTTP ${response.status}`;
    throw new Error(error);
  }
  return parseReport(body, organizationId, host);
}

export async function importWelesTrajectoryFile(
  path: string,
  targetHost: string,
  options: WelesImportClientOptions = {},
): Promise<WelesImportReport> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`trajectory export is not a readable file: ${path}`);
  if (metadata.size > MAX_IMPORT_BYTES) throw new Error('trajectory export exceeds 2 MiB');
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error('trajectory export exceeds 2 MiB');
  let source: unknown;
  try {
    source = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('trajectory export must be valid JSON');
  }
  return importWelesTrajectoryDocument(source, targetHost, options);
}
