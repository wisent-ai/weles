#!/usr/bin/env node

import { STATUS_CODES } from 'node:http';
import { readFileSync, writeSync } from 'node:fs';
import { loopbackAddress } from '../../../_shared/skarbiec-runtime.mjs';
import { issuedBearer, readValue, workloadProof } from './proof.mjs';
import { acquisitionPost, readRefusalDetail } from './transport.mjs';

/** A refused acquisition exits with the C library's `EXIT_FAILURE`: https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/stdlib.h.html */
const EXIT_FAILURE = 1;
/** The one name a URL may give this machine by, reserved for its loopback (RFC 6761 section 6.3). */
const LOOPBACK_NAME = 'localhost';

// A refusal whose cause the caller must act on differently ends with one
// machine line naming that cause (refused, scope_not_declared,
// authority_unreachable, workload_not_authorized, field_not_present), so the
// caller reads the line instead of the words of the sentence above it.
// The write is synchronous: stderr is a pipe to the reader, where Node's
// process.stderr.write is asynchronous and process.exit may drop the line.
function stop(reason, message) {
  writeSync(
    process.stderr.fd,
    `${message}\nSKARBIEC_ACQUIRE_REASON ${reason}\n`,
  );
  process.exit(EXIT_FAILURE);
}

const [, , scopeFile, consumer, item, field, ...extraArgs] = process.argv;
if (
  extraArgs.length ||
  [scopeFile, consumer, item, field].some((value) => !value)
) {
  throw new Error(
    'usage: skarbiec-acquire.mjs <scope-file> <consumer> <item> <field>',
  );
}
const request = { consumer, item, field };

const exactName = /^[A-Za-z\d._-]+$/;
// The item column may name a role instead of an item, `role:<role>`: the grant
// is `acquire:role:<role>#<field>` and Skarbiec redeems the one live item
// tagged `stado:role:<role>`, so neither this catalog nor the caller names a
// vault item.
const exactCoordinate = (value) =>
  exactName.test(
    value.startsWith('role:') ? value.slice('role:'.length) : value,
  );
if (
  !exactName.test(consumer) ||
  !exactCoordinate(item) ||
  !exactName.test(field)
) {
  throw new Error(
    'consumer and field must be exact names, and item an exact name or role:<exact name>',
  );
}

const scopeKeys = readFileSync(scopeFile, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const [rowConsumer, rowItem, rowField, ...beyond] = line.split('|');
    if (
      beyond.length ||
      rowField === undefined ||
      !exactName.test(rowConsumer) ||
      !exactCoordinate(rowItem) ||
      !exactName.test(rowField)
    ) {
      throw new Error(
        `invalid Skarbiec bootstrap scope ${JSON.stringify(line)} in ${scopeFile}; expected consumer|item|field, item an exact name or role:<exact name>`,
      );
    }
    return line;
  });
if (!scopeKeys.length || new Set(scopeKeys).size !== scopeKeys.length) {
  throw new Error(
    `Skarbiec bootstrap scope catalog ${scopeFile} must be nonempty and duplicate-free`,
  );
}
if (!scopeKeys.includes([consumer, item, field].join('|'))) {
  // Name the table that was read and how big it is: this refusal is produced
  // before the authority is contacted, so when it fires the interesting fact is
  // WHICH copy of the catalogue is in force, not the grant.
  stop(
    'scope_not_declared',
    `undeclared Skarbiec acquisition scope for ${consumer} on ${item}#${field} in ${scopeFile} (${scopeKeys.length} declared scopes)`,
  );
}

// The authority is the one the Stado service directory names, exported by the
// caller; there is no built-in address and no second authority to fall to. A
// Skarbiec that does not answer is refused as authority_unreachable by the
// request itself (transport.mjs), naming the operation and its cause.
const endpointText = process.env.WC_SKARBIEC_URL?.trim();
if (!endpointText)
  throw new Error('WC_SKARBIEC_URL must come from the Stado service directory');
if (!URL.canParse(endpointText))
  throw new Error(
    `WC_SKARBIEC_URL ${JSON.stringify(endpointText)} is not a URL`,
  );
const endpoint = new URL(endpointText);
const loopback =
  endpoint.hostname === LOOPBACK_NAME || loopbackAddress(endpoint.hostname);
if (
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  (endpoint.pathname !== '/' && endpoint.pathname !== '') ||
  (endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && loopback))
) {
  throw new Error(
    `Skarbiec endpoint ${endpoint.origin} must be an HTTPS origin or an HTTP origin on this machine's loopback`,
  );
}

const proof = workloadProof(process.env, request);

/** The HTTP status the specification names `name`, as Node's own table of statuses holds it. */
const statusNamed = (name) =>
  Object.keys(STATUS_CODES).find((code) => STATUS_CODES[code] === name);
// Skarbiec's statuses for a proved workload: Not Found is a field the item
// does not carry (skarbiec README, acquisition), Unauthorized a tuple no grant
// covers. Any other refusal is `refused`.
const REFUSAL_BY_STATUS = {
  [statusNamed('Not Found')]: 'field_not_present',
  [statusNamed('Unauthorized')]: 'workload_not_authorized',
};

async function refuse(stage, response) {
  const detail = await readRefusalDetail(response);
  const reason = Object.hasOwn(REFUSAL_BY_STATUS, response.status)
    ? REFUSAL_BY_STATUS[response.status]
    : 'refused';
  stop(
    reason,
    `Skarbiec ${stage} at ${endpoint.origin} refused ${consumer} for ${item}#${field}: HTTP ${response.status}` +
      `${detail ? ` ${detail}` : ''}` +
      // The workload identity is public proof context, not a bearer or secret.
      ` [asserted workload_id=${proof.workload_id}, proof over ${consumer}\0${item}\0${field}]`,
  );
}

const commonHeaders = {
  'Content-Type': 'application/json',
  'X-Consumer': consumer,
};
const post = acquisitionPost({ endpoint, consumer, item, field, stop });

const issueResponse = await post(
  '/v1/acquisitions',
  commonHeaders,
  JSON.stringify({ id: item, field, ...proof }),
);
if (!issueResponse.ok) await refuse('acquisition issue', issueResponse);
const token = issuedBearer(await issueResponse.json(), request);

const readResponse = await post(
  '/v1/acquisitions/read',
  { ...commonHeaders, Authorization: `Bearer ${token}` },
  JSON.stringify({ id: item, field }),
);
if (!readResponse.ok) await refuse('one-time read', readResponse);
process.stdout.write(
  readValue(await readResponse.json(), request, endpoint.origin),
);
