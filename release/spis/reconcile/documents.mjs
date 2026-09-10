// Reading and durably writing the JSON documents the reconciler moves
// between Stado, the registry and the trust file, plus the shape checks
// every mode applies before it trusts one.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function readJson(path) {
  return JSON.parse(path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  const document = `${JSON.stringify(value, null, 2)}\n`;
  if (path === '-') {
    process.stdout.write(document);
    return;
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.new`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, document, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    const directory = openSync(parent, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function objectAt(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

export function arrayAt(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

