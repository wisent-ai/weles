// The one form an artifact locator may take: a private Weles recordings URI
// under a canonical run UUID, with no character that could leave that path.
import { constants } from 'node:http2';
import { UUID_RE } from '../../../utils/capability/broker.js';
import { RequestFailure } from '../delivery-http.js';

const WELES_ARTIFACT_PREFIX = 'stado://weles/recordings/';

const { HTTP_STATUS_BAD_REQUEST } = constants;

/** Characters that could leave the recordings path or end the locator early. */
const FORBIDDEN_CHARACTER = /[\\?#]/;
/** Control characters, NUL among them. */
const CONTROL_CHARACTER = /\p{Cc}/u;

function refused(message: string): RequestFailure {
  return new RequestFailure(HTTP_STATUS_BAD_REQUEST, message);
}

/** `value` when it is a canonical Weles artifact locator; refused with the rule it breaks otherwise. */
export function canonicalWelesArtifactUri(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim())
    throw refused('artifact locator must be a canonical string');
  if (!value.startsWith(WELES_ARTIFACT_PREFIX))
    throw refused(
      'artifact locator must use the private Weles recordings namespace',
    );
  if (FORBIDDEN_CHARACTER.test(value))
    throw refused('artifact locator contains a forbidden character');
  if (CONTROL_CHARACTER.test(value))
    throw refused('artifact locator contains a control character');
  const [runId, ...path] = value.slice(WELES_ARTIFACT_PREFIX.length).split('/');
  if (
    !path.length ||
    [runId, ...path].some((part) => !part || part === '.' || part === '..')
  )
    throw refused('artifact locator has an invalid path');
  if (runId !== runId.toLowerCase() || !UUID_RE.test(runId))
    throw refused('artifact locator must contain a canonical run UUID');
  return value;
}
