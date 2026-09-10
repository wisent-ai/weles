import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function atomicJsonWrite(path, document) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `atomic JSON write did not publish ${path}: ${error.message}; and its temporary file ${temporary} could not be removed: ${cleanupError.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function atomicBufferWrite(path, body) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `atomic byte write did not publish ${path}: ${error.message}; and its temporary file ${temporary} could not be removed: ${cleanupError.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function cleanInterruptedTemporaryFiles(directory, entries) {
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.tmp')) {
      await rm(join(directory, entry.name), { force: true });
    }
  }
  await syncDirectory(directory);
}
