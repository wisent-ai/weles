import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(remote)) {
    throw new Error(
      'design export remote must name a configured Git remote, not a URL',
    );
  }
  const branch = text(input?.branch, 'branch');
  const credential = input?.credential;
  const endpoint = new URL(text(credential?.endpoint, 'credential.endpoint'));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
    endpoint.hostname,
  );
  if (
    (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && loopback)) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  ) {
    throw new Error(
      'credential.endpoint must be an HTTPS origin or loopback HTTP origin without credentials',
    );
  }
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
  const output = join(checkout, 'figma');
  for (const [label, file] of [
    ['request', path],
    ['inventory', inventoryPath],
    ['credential.scopeFile', scopeFile],
    ['credential.signingKeyFile', signingKeyFile],
  ]) {
    const actual = realpathSync(file);
    if (actual === output || actual.startsWith(`${output}${sep}`)) {
      throw new Error(
        `design export ${label} must be outside the managed figma directory`,
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
    const name = text(entry?.name, `inventory.companyFiles[${index}].name`);
    const url = new URL(
      text(entry?.url, `inventory.companyFiles[${index}].url`),
    );
    const match = url.pathname.match(
      /^\/(design|file|board|slides|make|proto)\/([a-z0-9]+)(?:\/|$)/i,
    );
    if (
      url.protocol !== 'https:' ||
      !['figma.com', 'www.figma.com'].includes(url.hostname) ||
      url.username ||
      url.password ||
      !match
    ) {
      throw new Error(
        `inventory.companyFiles[${index}].url must identify an HTTPS Figma file`,
      );
    }
    const key = match[2];
    if (keys.has(key)) throw new Error(`Figma inventory repeats file ${key}`);
    keys.add(key);
    return { name, type: match[1].toLowerCase(), key };
  });
  return {
    checkout,
    remote,
    branch,
    endpoint: endpoint.href,
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
