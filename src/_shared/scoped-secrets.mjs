// A trajectory's own service credentials (the one service catalog,
// src/secrets/scoped-service/catalog/services.json): each field is read
// through the workload-bound Skarbiec acquisition the TypeScript transport
// performs (src/secrets/scoped-service/transport.ts readAcquiredField),
// asking for the role the credential plays, and a writable service's fields
// are written to the item playing that role by `stado credentials put
// --role`, under Stado's own identity on the host. Without Skarbiec, the
// owner-only WELES_CREDENTIALS_FILE holds the fields under the role name.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { readAcquiredField } from '../../dist/secrets/scoped-service/transport.js';
import { stadoBinary } from './skarbiec-runtime.mjs';
import {
  localCredentialsFile,
  readLocalField,
  writeLocalFields,
} from './local-credentials.mjs';
import { SERVICE_CONTRACTS } from '../../dist/secrets/scoped-service/catalog/services.js';

const CATALOG = 'src/secrets/scoped-service/catalog/services.json';

/** The service `serviceName` names, refused by name when none is declared. */
function declaredService(serviceName) {
  if (!Object.hasOwn(SERVICE_CONTRACTS, serviceName))
    throw new Error(
      `unknown Weles scoped secret service: ${serviceName}; declare it in ${CATALOG}`,
    );
  return SERVICE_CONTRACTS[serviceName];
}

/** The service, refused unless its credential holds a username and password. */
function loginService(serviceName) {
  const service = declaredService(serviceName);
  if (
    !Object.hasOwn(service.fields, 'username') ||
    !Object.hasOwn(service.fields, 'password')
  )
    throw new Error(
      `service is not an exact Weles scoped login contract: ${serviceName}`,
    );
  return service;
}

export function readScopedSecret(serviceName, field) {
  const service = declaredService(serviceName);
  if (!Object.hasOwn(service.fields, field))
    throw new Error(
      `field is not in the exact Weles scoped secret contract: ${serviceName}/${field}`,
    );
  // The local file names a field it does not hold, by item and field.
  const local = localCredentialsFile();
  if (local) return readLocalField(local, service.item, field);
  const value = readAcquiredField(
    service.consumer,
    service.item,
    field,
    undefined,
    `role:${service.item}`,
  );
  // The transport reads nothing only when this process carries no workload
  // identity to acquire with.
  if (value === undefined)
    throw new Error(
      `Skarbiec workload identity is required to read ${serviceName}/${field}: set SKARBIEC_WORKLOAD_ID and SKARBIEC_WORKLOAD_SIGNING_KEY_FILE, or WELES_CREDENTIALS_FILE on a machine without Skarbiec`,
    );
  return value;
}

/** The service, refused by name unless it declares the item kind Weles writes. */
function writableService(serviceName) {
  const service = declaredService(serviceName);
  if (!service.kind)
    throw new Error(
      `Weles does not write ${serviceName}: a written service declares the Skarbiec kind its item is stored as in ${CATALOG}`,
    );
  return service;
}

/**
 * Refuses, before a trajectory changes anything at the provider, a service
 * this host cannot write: one Weles does not write, or, with Skarbiec, a host
 * without the Stado program the write runs through.
 */
export function assertScopedSecretWriter(serviceName) {
  writableService(serviceName);
  if (localCredentialsFile()) return;
  stadoBinary();
}

/**
 * What a scoped field may hold: text that is not blank and carries no NUL.
 * A field may span lines, as a PEM private key does; both writers carry the
 * value inside JSON, which keeps its line breaks.
 */
function fieldValue(serviceName, field, value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error(
      `refusing invalid scoped secret write for ${serviceName}/${field}: the value must be non-blank text without NUL characters`,
    );
  return value.trim();
}

export function writeScopedSecretItem(serviceName, fields) {
  const service = writableService(serviceName);
  if (!fields || typeof fields !== 'object')
    throw new Error(
      `write for ${serviceName} needs an object of its fields ${Object.keys(service.fields).join(', ')}`,
    );
  const entries = Object.entries(fields);
  if (
    entries.length !== Object.keys(service.fields).length ||
    entries.some(([field]) => !Object.hasOwn(service.fields, field))
  )
    throw new Error(
      `write does not match the exact Weles scoped secret contract for ${serviceName}: it must carry exactly ${Object.keys(service.fields).join(', ')}`,
    );
  const normalized = Object.fromEntries(
    entries.map(([field, value]) => [
      field,
      fieldValue(serviceName, field, value),
    ]),
  );
  const local = localCredentialsFile();
  if (local) {
    writeLocalFields(local, service.item, normalized);
    return;
  }
  const input = Buffer.from(JSON.stringify(normalized));
  const command = ['credentials', 'put', '--role', service.item];
  try {
    const program = stadoBinary();
    const args = [...command, '--type', service.kind];
    // Stado writes as itself: the child gets no Skarbiec consumer, token or
    // endpoint of this process, which Stado would refuse as an override.
    const result = spawnSync(program, args, {
      input,
      encoding: 'buffer',
      maxBuffer: Infinity,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        HOME: homedir(),
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      },
    });
    if (result.error || result.status || result.signal) {
      const exited = result.error
        ? `failed: ${result.error.message}${
            result.signal
              ? `; was ended by signal ${result.signal}`
              : result.status !== null
                ? `; exited with status ${result.status}`
                : ''
          }`
        : result.signal
          ? `was ended by signal ${result.signal}`
          : `exited with status ${result.status}`;
      // Buffer presence is independent of whether a process error was returned.
      // Every value this write carried is redacted wherever the helper echoed
      // it, before the text reaches the message or the execution record, as
      // the acquired writer does with its one credential. The helper was
      // handed the values as JSON, so each is redacted both as written and as
      // its JSON string body (quotes, backslashes and control characters
      // escaped), the longest form first so a value inside another leaves no
      // remainder of the longer one.
      const forms = Object.values(normalized)
        .map(String)
        .filter((value) => value)
        .flatMap((value) => [
          value,
          JSON.stringify(value).replace(/^"|"$/g, ''),
        ])
        .sort((left, right) => right.length - left.length);
      const capturedStderr = result.stderr
        ? forms.reduce(
            (text, form) => text.split(form).join('[redacted]'),
            result.stderr.toString('utf8'),
          )
        : undefined;
      const stderr =
        capturedStderr !== undefined
          ? (() => {
              const said = capturedStderr.trim();
              return said ? `: ${said}` : ' and wrote nothing to stderr';
            })()
          : ' and no stderr was captured';
      // spawnSync reports pid 0 when no child was created, so only a started
      // child's pid is quoted as an observation.
      const started = result.pid ? ` (pid ${result.pid})` : '';
      throw Object.assign(
        new Error(
          `scoped Skarbiec write failed for ${serviceName}: ${program} ${args.join(' ')} ${exited}${started}${stderr}`,
          { cause: result.error },
        ),
        {
          execution: {
            program,
            arguments: args,
            pid: result.pid,
            status: result.status,
            signal: result.signal,
            stderrCaptured: Buffer.isBuffer(result.stderr),
            stderr: capturedStderr,
          },
        },
      );
    }
  } finally {
    // An empty string zero-fills a Buffer.
    input.fill('');
  }
}

export function writeScopedLogin(serviceName, login) {
  const service = loginService(serviceName);
  writeScopedSecretItem(serviceName, {
    username: login.email,
    password: login.password,
    ...(Object.hasOwn(service.fields, 'totp_secret')
      ? { totp_secret: login.totpSecret }
      : {}),
  });
}

export function readScopedLogin(serviceName) {
  const service = loginService(serviceName);
  const email = readScopedSecret(serviceName, 'username');
  const password = readScopedSecret(serviceName, 'password');
  if (!Object.hasOwn(service.fields, 'totp_secret')) return { email, password };
  return {
    email,
    password,
    totpSecret: readScopedSecret(serviceName, 'totp_secret'),
  };
}

export function readScopedProxy(serviceName) {
  return {
    username: readScopedSecret(serviceName, 'username'),
    password: readScopedSecret(serviceName, 'password'),
  };
}
