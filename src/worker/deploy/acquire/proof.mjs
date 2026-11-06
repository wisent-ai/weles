// The workload's proof of who asks, and the checks on what Skarbiec answers,
// for `skarbiec-acquire.mjs`. Skarbiec is the authority on every rule it
// enforces itself (the workload id's form, the signature, the provider
// metadata); this side checks only what it must know before it sends a key
// or hands a value on.
import { createHash, randomBytes, sign } from 'node:crypto';
import { constants, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** A signing key file anyone but its owner may read or write is refused: the group and other permission bits. */
const UNSAFE_BITS = constants.S_IRWXG | constants.S_IRWXO;
const MILLISECONDS_PER_SECOND = Date.parse('1970-01-01T00:00:01Z');
/**
 * Skarbiec's credential model publishes the nonce as one 32-byte random
 * value, unpadded base64url (https://skarbiec.wisent.com/docs/credential-model):
 * the size of a SHA-256 digest.
 */
const NONCE_BYTES = createHash('sha256').digest().length;

/** The workload id as Skarbiec accepts one: nonempty, without surrounding space, with no control character. */
function workloadIdFrom(environment) {
  const workloadId = environment.SKARBIEC_WORKLOAD_ID;
  if (
    typeof workloadId !== 'string' ||
    !workloadId ||
    workloadId.trim() !== workloadId ||
    /\p{Cc}/u.test(workloadId)
  ) {
    throw new Error(
      'SKARBIEC_WORKLOAD_ID must be nonempty text without surrounding space or control characters',
    );
  }
  return workloadId;
}

/** The workload's signing key, from a regular file only its owner, this user, can read. */
function signingKeyFrom(environment) {
  const signingKeyFile = environment.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE;
  if (!signingKeyFile || !isAbsolute(signingKeyFile)) {
    throw new Error(
      'SKARBIEC_WORKLOAD_SIGNING_KEY_FILE must be an absolute path',
    );
  }
  const metadata = lstatSync(signingKeyFile);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    metadata.mode & UNSAFE_BITS
  ) {
    throw new Error(
      `unsafe Skarbiec workload signing key file ${signingKeyFile}: it must be a regular file this user owns, closed to group and others`,
    );
  }
  return readFileSync(signingKeyFile);
}

/**
 * The proof fields an acquisition request carries for `consumer` on
 * `item#field`: the workload id, the time in whole seconds, a fresh nonce and
 * the signature over all of them, in the payload Skarbiec verifies.
 */
export function workloadProof(environment, { consumer, item, field }) {
  const workloadId = workloadIdFrom(environment);
  const timestamp = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  const payload = Buffer.from(
    [
      'SKARBIEC-WORKLOAD-ACQUISITION',
      'v1',
      consumer,
      item,
      field,
      workloadId,
      String(timestamp),
      nonce,
    ].join('\0'),
    'utf8',
  );
  const signingKey = signingKeyFrom(environment);
  try {
    return {
      workload_id: workloadId,
      workload_timestamp: timestamp,
      workload_nonce: nonce,
      workload_signature: sign(null, payload, signingKey).toString('hex'),
    };
  } finally {
    signingKey.fill(Buffer.from('\0'));
    payload.fill(Buffer.from('\0'));
  }
}

const ISSUED_FIELDS = ['consumer', 'expires_at', 'field', 'item', 'token'];

/** The field-bound bearer Skarbiec issued, refused unless it is bound to exactly this request. */
export function issuedBearer(issued, { consumer, item, field }) {
  const answer = Object(issued);
  if (
    answer.consumer !== consumer ||
    answer.item !== item ||
    answer.field !== field ||
    Object.keys(answer).sort().join('|') !== ISSUED_FIELDS.join('|') ||
    typeof answer.token !== 'string' ||
    !answer.token ||
    /\s/.test(answer.token) ||
    !Number.isSafeInteger(answer.expires_at)
  ) {
    throw new Error(
      `Skarbiec returned an invalid field-bound acquisition bearer for ${consumer} on ${item}#${field}: fields ${JSON.stringify(Object.keys(answer))}`,
    );
  }
  return answer.token;
}

// The fields of the one-time read answer, each with whether it must be
// there: the binding it echoes (consumer, item, field), the value, and the
// provider Skarbiec declares only when the item names one.
const READ_ANSWER_FIELDS = {
  consumer: true,
  field: true,
  item: true,
  value: true,
  provider: false,
};

function typeOf(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/** The value Skarbiec's one-time read answered, refused with the answer's shape (never its value) unless it is exactly the bound field. */
export function readValue(result, { consumer, item, field }, origin) {
  const answer = Object(result);
  const keys = Object.keys(answer);
  const providerValid =
    !Object.hasOwn(answer, 'provider') ||
    (typeof answer.provider === 'string' && Boolean(answer.provider));
  if (
    answer.consumer === consumer &&
    answer.item === item &&
    answer.field === field &&
    !Object.entries(READ_ANSWER_FIELDS).some(
      ([key, required]) => required && !keys.includes(key),
    ) &&
    !keys.some((key) => !Object.hasOwn(READ_ANSWER_FIELDS, key)) &&
    typeof answer.value === 'string' &&
    answer.value &&
    providerValid
  ) {
    return answer.value;
  }
  const shape = {
    keys,
    consumerMatches: answer.consumer === consumer,
    itemMatches: answer.item === item,
    fieldMatches: answer.field === field,
    valueType: typeOf(answer.value),
    valueLength: typeof answer.value === 'string' ? answer.value.length : null,
    providerType: typeOf(answer.provider),
    providerValid,
  };
  throw new Error(
    `Skarbiec returned an invalid single-field response at ${origin} for ${consumer} on ${item}#${field}: ${JSON.stringify(shape)}`,
  );
}
