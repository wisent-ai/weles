import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { serviceOrigin } from '../../dist/utils/runtime/service-origin.js';

/** The host Figma serves its files from; www.figma.com is a name under it. */
const FIGMA_HOST = 'figma.com';

/** Whether `hostname` is Figma's own host or a name under it. */
function figmaHost(hostname) {
  return hostname === FIGMA_HOST || hostname.endsWith(`.${FIGMA_HOST}`);
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`design export request requires a non-empty ${field}`);
  }
  return value;
}

function json(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error.message}`);
  }
}

/** Paths in a request belong to that file, not the caller's working directory. */
export function readExportRequest(path) {
  const root = dirname(resolve(path));
  const input = json(path, 'design export request');
  const inventoryPath = resolve(root, text(input?.inventory, 'inventory'));
  const checkout = realpathSync(
    resolve(root, text(input?.checkout, 'checkout')),
  );
  const remote = text(input?.remote, 'remote');
  if (!/^[a-z\d][a-z\d._-]*$/i.test(remote)) {
    throw new Error(
      'design export remote must name a configured Git remote, not a URL',
    );
  }
  const branch = text(input?.branch, 'branch');
  const credential = input?.credential;
  const endpoint = serviceOrigin(
    'credential.endpoint',
    text(credential?.endpoint, 'credential.endpoint'),
  );
  const consumer = text(credential?.consumer, 'credential.consumer');
  const item = text(credential?.item, 'credential.item');
  const field = text(credential?.field, 'credential.field');
  const scopeFile = realpathSync(
    resolve(root, text(credential?.scopeFile, 'credential.scopeFile')),
  );
  const workloadId = text(credential?.workloadId, 'credential.workloadId');
  const signingKeyFile = resolve(
    root,
    text(credential?.signingKeyFile, 'credential.signingKeyFile'),
  );
  // The managed directory the export replaces, relative to the checkout:
  // `figma` unless the request names another one (a repository holding
  // several design libraries keeps each in its own directory).
  const managed =
    input?.output === undefined
      ? 'figma'
      : normalize(text(input.output, 'output')).replace(/[\\/]+$/, '');
  if (
    isAbsolute(managed) ||
    managed === '.' ||
    managed === '..' ||
    managed.startsWith(`..${sep}`) ||
    managed.split(/[\\/]/).includes('.git')
  ) {
    throw new Error(
      `design export output must be a directory inside the checkout, relative to it and outside .git: ${JSON.stringify(input.output)}`,
    );
  }
  const output = join(checkout, managed);
  for (const [label, file] of [
    ['request', path],
    ['inventory', inventoryPath],
    ['credential.scopeFile', scopeFile],
    ['credential.signingKeyFile', signingKeyFile],
  ]) {
    const actual = realpathSync(file);
    if (actual === output || actual.startsWith(`${output}${sep}`)) {
      throw new Error(
        `design export ${label} must be outside the managed output directory ${managed}`,
      );
    }
  }
  const inventory = json(inventoryPath, 'Figma inventory');
  const teamId = text(inventory?.teamId, 'inventory.teamId');
  if (
    !Array.isArray(inventory.companyFiles) ||
    !inventory.companyFiles.length
  ) {
    throw new Error(
      'Figma inventory.companyFiles must contain at least one file',
    );
  }
  const keys = new Set();
  const files = inventory.companyFiles.map((entry, index) => {
    const where = `inventory.companyFiles[${index}]`;
    const name = text(entry?.name, `${where}.name`);
    const raw = text(entry?.url, `${where}.url`);
    if (!URL.canParse(raw)) {
      throw new Error(`${where}.url is not a URL: ${JSON.stringify(raw)}`);
    }
    const url = new URL(raw);
    // A Figma file URL is /<kind>/<key>/<title>: the kind (design, board,
    // slides, ...) and the key are the first two path segments, whatever
    // kinds Figma adds later.
    const [, type, key] = url.pathname.split('/');
    if (
      url.protocol !== 'https:' ||
      !figmaHost(url.hostname) ||
      url.username ||
      url.password ||
      !type ||
      !key ||
      !/^[a-z\d]+$/i.test(key)
    ) {
      throw new Error(
        `${where}.url must be an HTTPS Figma file URL (https://www.figma.com/<kind>/<key>/...): ${JSON.stringify(raw)}`,
      );
    }
    if (keys.has(key)) throw new Error(`Figma inventory repeats file ${key}`);
    keys.add(key);
    return { name, type: type.toLowerCase(), key };
  });
  return {
    checkout,
    output: managed,
    remote,
    branch,
    endpoint,
    consumer,
    item,
    field,
    scopeFile,
    workloadId,
    signingKeyFile,
    teamId,
    files,
  };
}
