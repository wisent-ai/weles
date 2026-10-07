import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export async function evidenceFor(area) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = join(root, 'build/real-tests', area, randomUUID());
  await mkdir(directory, { recursive: true });
  const report = {
    source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    command: [process.execPath, ...process.argv.slice(1)],
    started_at: new Date().toISOString(),
    operations: [],
    recordings: [],
    recording_errors: [],
    status: 'running',
  };
  const runs = new Set();
  let connection;
  let operatorJson;
  const save = () =>
    writeFile(
      join(directory, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  async function connect() {
    const api = await import('../../dist/runtime/api/connection.js');
    operatorJson = api.operatorJson;
    connection = api.welesOperatorConnection('/runs');
  }
  async function request(
    path,
    body,
    authorization = connection.headers.Authorization,
  ) {
    const endpoint = new URL(path, connection.endpoint);
    const response = await connection.fetch(endpoint, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await operatorJson(response);
    report.operations.push({
      method: body ? 'POST' : 'GET',
      endpoint: endpoint.href,
      http_status: response.status,
      body: value,
    });
    if (typeof value.run_id === 'string') runs.add(value.run_id);
    await save();
    return { status: response.status, value };
  }
  function command(program, args, secret = false) {
    const result = spawnSync(program, args, { cwd: root, encoding: 'utf8' });
    report.operations.push({
      command: [program, ...args],
      exit_status: result.status,
      stdout: secret ? '[credential omitted]' : result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result.stdout;
  }
  async function retain(runId) {
    assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
    const manifest = await request(`/diagnostics/${encodeURIComponent(runId)}`);
    assert.equal(manifest.status, 200);
    const destination = join(directory, 'runs', runId);
    for (const file of manifest.value.files) {
      assert.ok(
        file.download_url.startsWith(
          `/diagnostics/${encodeURIComponent(runId)}/file?path=`,
        ),
      );
      const path = resolve(destination, file.path);
      assert.ok(
        path.startsWith(`${destination}${sep}`),
        'recordings must stay inside the report',
      );
      const response = await connection.fetch(
        new URL(file.download_url, connection.endpoint),
        {
          headers: connection.headers,
          redirect: 'error',
        },
      );
      assert.equal(response.status, 200, `${runId}/${file.path}`);
      await mkdir(dirname(path), { recursive: true });
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(path, { mode: 0o600 }),
      );
      report.recordings.push({
        run_id: runId,
        path,
        content_type: file.content_type,
        bytes: file.bytes,
      });
    }
  }
  async function finish() {
    if (connection) {
      for (const run of runs) {
        try {
          await retain(run);
        } catch (error) {
          report.recording_errors.push({ run_id: run, message: error.message });
          report.status = 'failed';
          process.exitCode = 1;
        }
      }
    }
    report.finished_at = new Date().toISOString();
    await save();
    console.log(
      JSON.stringify(
        { report: join(directory, 'report.json'), ...report },
        null,
        2,
      ),
    );
  }
  return { report, runs, connect, request, command, finish };
}
