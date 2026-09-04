import * as net from 'node:net';

/**
 * Check if a URL endpoint is currently listening (for TCP-based services).
 * @param {string} urlString The URL to check
 * @param {number} timeoutMs Timeout in milliseconds
 * @returns {Promise<boolean>} true if listening
 */
export async function isEndpointListening(urlString, timeoutMs = 1000) {
  try {
    const url = new URL(urlString);
    const host = url.hostname;
    const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);

    if (isNaN(port) || port < 1 || port > 65535) {
      return false;
    }

    const { promise, resolve } = Promise.withResolvers();
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
 *
 * @returns {Promise<{resolved: {url, source, sourceDetail, isListening}|null, candidates: Array, wasExplicitOverride: boolean}>}
 */
export async function resolveSkarbiecEndpoint() {
  const envUrl = process.env.WC_SKARBIEC_URL?.trim();
  if (!envUrl) {
    return { resolved: null, candidates: [], wasExplicitOverride: false };
  }

  const resolved = {
    url: envUrl,
    source: 'environment',
    sourceDetail: 'WC_SKARBIEC_URL environment variable',
    isListening: await isEndpointListening(envUrl),
  };
  return { resolved, candidates: [resolved], wasExplicitOverride: true };
}

/**
 * Format an endpoint error message with clear details.
 * @param {Object} info Endpoint info object
 * @returns {string} Formatted error message
 */
export function formatEndpointErrorMessage(info) {
  const sourceLabel = `environment variable (${info.sourceDetail.split(' ')[0]})`;

  const listeningStatus = info.isListening ? 'listening' : 'not listening';

  return `Skarbiec endpoint at ${info.url} (from ${sourceLabel}) is ${listeningStatus}`;
}
