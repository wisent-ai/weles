import { readFileSync } from 'node:fs';
import { readRequest } from '@wisent-ai/weles-client/credential/input';

const CONSUMER = 'weles-credential-admission';
const TOKEN_FILE = 'weles-credential-admission-skarbiec-token';
const CAPABILITY = 'credential-operations';

export class CredentialAdmissionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Resolve each caller against its issuing authority. A revoked or expired
// bearer must not remain usable because the Weles process has not restarted.
export function createCredentialAuthority({ checkedTokenFile, skarbiecEndpoint }) {
  return async function authorize(request) {
    const header = request.headers.authorization;
    const count = request.rawHeaders.filter((value, index) => index % 2 === 0
      && value.toLowerCase() === 'authorization').length;
    const presented = typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header);
    if (count !== 1 || !presented || header.length > 4096) {
      throw new CredentialAdmissionError(401, 'WELES_CREDENTIAL_UNAUTHORIZED', 'one bearer is required');
    }
    let own;
    let endpoint;
    try {
      const path = checkedTokenFile(TOKEN_FILE);
      if (!path) throw new Error(`missing ${TOKEN_FILE}`);
      own = readFileSync(path, 'utf8').trim();
      if (!own || /\s/.test(own)) throw new Error(`invalid ${TOKEN_FILE}`);
      endpoint = skarbiecEndpoint();
    } catch (error) {
      throw new CredentialAdmissionError(503, 'WELES_CREDENTIAL_AUTH_UNCONFIGURED', error.message);
    }
    let response;
    let identity;
    try {
      response = await fetch(`${endpoint}/v1/tokens/introspect`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${own}`,
          'X-Consumer': CONSUMER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: presented[1] }),
      });
      identity = await readRequest(response.body);
    } catch (error) {
      throw new CredentialAdmissionError(503, 'WELES_CREDENTIAL_AUTH_UNAVAILABLE',
        `Skarbiec token introspection failed: ${error.cause?.code || error.code || error.message}`);
    }
    if (!response.ok) {
      throw new CredentialAdmissionError(503, 'WELES_CREDENTIAL_AUTH_REFUSED',
        `Skarbiec refused ${CONSUMER} token introspection with HTTP ${response.status}`);
    }
    if (identity.active !== true) {
      throw new CredentialAdmissionError(401, 'WELES_CREDENTIAL_UNAUTHORIZED', 'bearer is not active');
    }
    if (identity.audience !== 'weles' || typeof identity.consumer !== 'string'
        || !Array.isArray(identity.capabilities)
        || !identity.capabilities.some((scope) => scope.action === 'call'
          && scope.item === 'weles' && scope.field === CAPABILITY)) {
      throw new CredentialAdmissionError(403, 'WELES_CREDENTIAL_SCOPE_REFUSED',
        `bearer requires audience weles and call:weles#${CAPABILITY}`);
    }
    return identity.consumer;
  };
}
