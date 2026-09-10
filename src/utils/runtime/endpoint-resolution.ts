import * as net from 'node:net';

export interface EndpointInfo {
  url: string;
  source: 'environment';
  sourceDetail: string;
  isListening: boolean;
}

export interface EndpointResolutionResult {
  resolved: EndpointInfo | null;
  candidates: EndpointInfo[];
  wasExplicitOverride: boolean;
}

/**
 * Check if a URL endpoint is currently listening (for TCP-based services).
 * Attempts a quick socket connection and immediately closes it.
 * @param urlString The URL to check (e.g., 'http://127.0.0.1:9000')
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
 * Resolve the exact Skarbiec endpoint exported by a caller after consulting the
 * Stado service directory. This helper deliberately has no marker scan or
 * built-in address: a missing declaration is a startup error, not permission to
 * select a second authority.
 */
export async function resolveSkarbiecEndpoint(): Promise<EndpointResolutionResult> {
  const envUrl = process.env.WC_SKARBIEC_URL?.trim();
  if (!envUrl) {
    return { resolved: null, candidates: [], wasExplicitOverride: false };
  }

  const resolved: EndpointInfo = {
    url: envUrl,
    source: 'environment',
    sourceDetail: 'WC_SKARBIEC_URL environment variable',
    isListening: await isEndpointListening(envUrl),
  };
  return { resolved, candidates: [resolved], wasExplicitOverride: true };
}

/**
 * Format an endpoint resolution error message with clear details.
 * @param info The endpoint info that failed
 * @returns A formatted error message
 */
export function formatEndpointErrorMessage(info: EndpointInfo): string {
  const sourceLabel = `environment variable (${info.sourceDetail.split(' ')[0]})`;

  const listeningStatus = info.isListening ? 'listening' : 'not listening';

  return `Skarbiec endpoint at ${info.url} (from ${sourceLabel}) is ${listeningStatus}`;
}
