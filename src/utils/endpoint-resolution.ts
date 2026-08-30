import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as net from 'node:net';

export interface EndpointInfo {
  url: string;
  source: 'environment' | 'forward-marker' | 'default';
  sourceDetail: string;
  isListening: boolean;
}

export interface EndpointResolutionResult {
  resolved: EndpointInfo | null;
  candidates: EndpointInfo[];
}

/**
 * Check if a URL endpoint is currently listening (for TCP-based services).
 * Attempts a quick socket connection and immediately closes it.
 * @param urlString The URL to check (e.g., 'http://127.0.0.1:8895')
 * @param timeoutMs Timeout for the connection attempt in milliseconds
 * @returns Promise<boolean> true if the endpoint appears to be listening
 */
export async function isEndpointListening(
  urlString: string,
  timeoutMs: number = 1000
): Promise<boolean> {
  try {
    const url = new URL(urlString);
    const host = url.hostname;
    const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);

    if (isNaN(port) || port < 1 || port > 65535) {
      return false;
    }

    const { promise, resolve } = Promise.withResolvers<boolean>();
    const socket = new net.Socket();
    const timeoutHandle = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on('connect', () => {
      clearTimeout(timeoutHandle);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timeoutHandle);
      resolve(false);
    });

    socket.connect(port, host);
    return promise;
  } catch {
    return false;
  }
}

/**
 * Read a URL from a forward marker file in ~/.stado/forwards/
 * Forward markers are simple files containing a single URL.
 * @param markerName Name of the marker file (without directory), e.g., 'skarbiec.local'
 * @returns The URL from the marker file, or null if not found or unreadable
 */
function readForwardMarker(markerName: string): string | null {
  try {
    const markerPath = join(homedir(), '.stado', 'forwards', markerName);
    const content = readFileSync(markerPath, 'utf8').trim();
    if (content) {
      return content;
    }
  } catch {
    // Marker file not found or unreadable, return null
  }
  return null;
}

/**
 * Resolve Skarbiec endpoint from multiple sources in priority order:
 * 1. WC_SKARBIEC_URL environment variable
 * 2. WELES_CREDENTIAL_SKARBIEC_URL environment variable
 * 3. Forward markers in ~/.stado/forwards/ (tried in order: skarbiec-weles.local, skarbiec.local, skarbiec-weles.url, skarbiec.url, mini-skarbiec-8895.url)
 * 4. Built-in default (http://127.0.0.1:8895)
 *
 * Prefers a candidate that is actually listening over one that is not.
 * @returns Promise<EndpointResolutionResult> containing resolved endpoint and all candidates tried
 */
export async function resolveSkarbiecEndpoint(): Promise<EndpointResolutionResult> {
  const candidates: EndpointInfo[] = [];

  // 1. Environment overrides (highest priority)
  const envUrl = process.env.WC_SKARBIEC_URL?.trim() || process.env.WELES_CREDENTIAL_SKARBIEC_URL?.trim();
  if (envUrl) {
    const isListening = await isEndpointListening(envUrl);
    candidates.push({
      url: envUrl,
      source: 'environment',
      sourceDetail: envUrl === process.env.WC_SKARBIEC_URL
        ? 'WC_SKARBIEC_URL environment variable'
        : 'WELES_CREDENTIAL_SKARBIEC_URL environment variable',
      isListening,
    });
  }

  // 2. Forward markers (medium priority)
  const markerNames = [
    'skarbiec-weles.local',
    'skarbiec.local',
    'skarbiec-weles.url',
    'skarbiec.url',
    'mini-skarbiec-8895.url',
  ];
  for (const markerName of markerNames) {
    const markerUrl = readForwardMarker(markerName);
    if (markerUrl && !candidates.some((c) => c.url === markerUrl)) {
      const isListening = await isEndpointListening(markerUrl);
      candidates.push({
        url: markerUrl,
        source: 'forward-marker',
        sourceDetail: `${homedir()}/.stado/forwards/${markerName}`,
        isListening,
      });
    }
  }

  // 3. Built-in default (lowest priority)
  const defaultUrl = 'http://127.0.0.1:8895';
  const isListening = await isEndpointListening(defaultUrl);
  candidates.push({
    url: defaultUrl,
    source: 'default',
    sourceDetail: 'built-in default',
    isListening,
  });

  // Return the first listening endpoint, or the first one tried if none are listening
  const resolved = candidates.find((c) => c.isListening) || candidates[0] || null;

  return { resolved, candidates };
}

/**
 * Format an endpoint resolution error message with clear details.
 * @param info The endpoint info that failed
 * @returns A formatted error message
 */
export function formatEndpointErrorMessage(info: EndpointInfo): string {
  const sourceLabel = info.source === 'environment'
    ? `environment variable (${info.sourceDetail.split(' ')[0]})`
    : info.source === 'forward-marker'
      ? `forward marker (${info.sourceDetail})`
      : info.source;

  const listeningStatus = info.isListening ? 'listening' : 'not listening';

  return `Skarbiec endpoint at ${info.url} (from ${sourceLabel}) is ${listeningStatus}`;
}
