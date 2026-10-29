// Real proxy, declared HTTPS address service and a controlled refused endpoint.
// No provider replacement, fabricated CONNECT response, browser or top-up.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('proxy-exit-address');
const declaredService = process.env.WELES_PUBLIC_ADDRESS_URL;
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for real proxy qualification`);
  return value;
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let failure;
try {
  assert.equal(
    required('WELES_SOURCE_REVISION'),
    evidence.report.source_revision,
  );
  const sources = [
    'src/utils/runtime/public-address.ts',
    'src/proxy/resolve/exit/tunnel.ts',
    'src/proxy/resolve/exit_preflight.ts',
    'src/diagnostics/versions/machine.ts',
    'src/diagnostics/versions/failures.ts',
    'src/_shared/error-chain/index.cjs',
    'tests/proxy/machine-address.mjs',
    'tests/proxy/exit-address.mjs',
  ];
  execFileSync('git', ['ls-files', '--error-unmatch', '--', ...sources], {
    cwd: root,
  });
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', ...sources], {
    cwd: root,
  });
  evidence.report.source_digests = {};
  for (const source of sources)
    evidence.report.source_digests[source] = hash(
      await readFile(new URL(`../../${source}`, import.meta.url)),
    );
  const module = new URL(
    '../../dist/proxy/resolve/exit/tunnel.js',
    import.meta.url,
  );
  const declaration = new URL(
    '../../dist/utils/runtime/public-address.js',
    import.meta.url,
  );
  const moduleHash = hash(await readFile(module));
  const declarationHash = hash(await readFile(declaration));
  assert.equal(moduleHash, required('WELES_TEST_TUNNEL_SHA256'));
  assert.equal(declarationHash, required('WELES_TEST_ADDRESS_SERVICE_SHA256'));
  evidence.report.module_digests = {
    tunnel: moduleHash,
    service: declarationHash,
  };
  for (const [name, path, declaration] of [
    ['machine', 'diagnostics/versions/machine.js', 'WELES_TEST_MACHINE_SHA256'],
    [
      'failures',
      'diagnostics/versions/failures.js',
      'WELES_TEST_CAPTURE_FAILURES_SHA256',
    ],
    [
      'error_chain',
      '_shared/error-chain/index.cjs',
      'WELES_TEST_ERROR_CHAIN_SHA256',
    ],
  ]) {
    const digest = hash(
      await readFile(new URL(`../../dist/${path}`, import.meta.url)),
    );
    assert.equal(digest, required(declaration));
    evidence.report.module_digests[name] = digest;
  }
  const { openTunnel, readExitAddress } = await import(module.href);
  const { publicAddressService } = await import(declaration.href);
  const url = new URL(required('WELES_TEST_PROXY_URL'));
  assert.equal(
    url.protocol,
    'http:',
    'the product CONNECT reader takes an HTTP proxy',
  );
  assert.ok(url.port, 'the actual proxy port must be declared');
  const proxy = {
    host: url.hostname,
    port: Number(url.port),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
  const refused = new URL(required('WELES_TEST_REFUSED_PROXY_URL'));
  assert.equal(refused.protocol, 'http:');
  assert.ok(
    refused.port,
    'declare the controlled endpoint that actually refuses connections',
  );
  const expected = required('WELES_TEST_EXIT_IP');
  assert.ok(
    isIP(expected),
    'declare the real fixed exit address independently of this probe',
  );
  required('WELES_PUBLIC_ADDRESS_URL');
  const service = publicAddressService();
  const nonIpService = new URL(required('WELES_TEST_NON_IP_ADDRESS_URL'));
  assert.equal(
    nonIpService.protocol,
    'https:',
    'the non-IP case must reach a real HTTPS service',
  );
  assert.equal(nonIpService.username, '');
  assert.equal(nonIpService.password, '');
  assert.equal(nonIpService.hash, '');
  const workerAddress = required('WELES_TEST_WORKER_PUBLIC_IP');
  assert.ok(
    isIP(workerAddress),
    'declare independent worker egress as well as proxy egress',
  );
  function machineCapture(endpoint) {
    if (endpoint === undefined) delete process.env.WELES_PUBLIC_ADDRESS_URL;
    else process.env.WELES_PUBLIC_ADDRESS_URL = endpoint;
    return JSON.parse(
      evidence.command(process.execPath, [
        fileURLToPath(new URL('./machine-address.mjs', import.meta.url)),
      ]),
    );
  }
  function machineRefusal(endpoint, operation, cause) {
    const observation = machineCapture(endpoint);
    assert.equal(
      Object.hasOwn(observation, 'public_ip'),
      false,
      'a failed capture must not publish public_ip',
    );
    const [failure, ...additional] = observation.failures;
    assert.deepEqual(additional, [], 'one real capture records one failure');
    assert.equal(failure.field, 'machine.public_ip');
    assert.equal(failure.operation, operation);
    assert.match(failure.message, cause);
    return observation;
  }
  machineRefusal(
    undefined,
    'resolve WELES_PUBLIC_ADDRESS_URL',
    /WELES_PUBLIC_ADDRESS_URL/,
  );
  const insecure = new URL(service);
  insecure.protocol = 'http:';
  machineRefusal(insecure.href, 'resolve WELES_PUBLIC_ADDRESS_URL', /HTTPS/);
  machineRefusal(
    nonIpService.href,
    `GET ${nonIpService}`,
    /answered no IP address/,
  );
  const refusedService = new URL(refused);
  refusedService.protocol = 'https:';
  refusedService.username = '';
  refusedService.password = '';
  machineRefusal(refusedService.href, `GET ${refusedService}`, /ECONNREFUSED/);
  const machine = machineCapture(service.href);
  assert.equal(
    machine.public_ip,
    workerAddress,
    'machine capture must observe the independent worker egress',
  );
  assert.deepEqual(machine.failures, []);
  evidence.report.proxy = { host: proxy.host, port: proxy.port };
  evidence.report.refused_proxy = {
    host: refused.hostname,
    port: Number(refused.port),
  };
  evidence.report.service = service.href;
  evidence.report.expected_exit_ip = expected;

  delete process.env.WELES_PUBLIC_ADDRESS_URL;
  await assert.rejects(readExitAddress(proxy), (cause) => {
    evidence.report.operations.push({
      operation: 'read exit without declared service',
      error: cause.message,
    });
    return cause.message.includes('WELES_PUBLIC_ADDRESS_URL');
  });
  const insecureService = new URL(service);
  insecureService.protocol = 'http:';
  process.env.WELES_PUBLIC_ADDRESS_URL = insecureService.href;
  await assert.rejects(readExitAddress(proxy), (cause) => {
    evidence.report.operations.push({
      operation: 'read exit with insecure service',
      error: cause.message,
    });
    return (
      cause.message.includes('WELES_PUBLIC_ADDRESS_URL') &&
      cause.message.includes('HTTPS')
    );
  });
  process.env.WELES_PUBLIC_ADDRESS_URL = service.href;

  const refusal = await openTunnel(
    {
      host: refused.hostname,
      port: Number(refused.port),
      username: decodeURIComponent(refused.username),
      password: decodeURIComponent(refused.password),
    },
    service.hostname,
  );
  if ('socket' in refusal) {
    refusal.socket.destroy();
    evidence.report.operations.push({
      operation: 'CONNECT to declared refused proxy endpoint',
      status_line: refusal.statusLine,
      status: refusal.status,
    });
    assert.fail(
      `the controlled refusal endpoint answered ${refusal.statusLine}`,
    );
  }
  assert.ok(
    'failure' in refusal,
    'a real socket refusal must not become a fabricated status',
  );
  evidence.report.operations.push({
    operation: 'CONNECT to declared refused proxy endpoint',
    error: refusal.failure,
  });
  assert.match(refusal.failure, /ECONNREFUSED/);

  await assert.rejects(readExitAddress(proxy, nonIpService), (cause) => {
    evidence.report.operations.push({
      operation: 'reject real non-IP HTTPS body through proxy',
      error: cause.message,
    });
    return (
      cause.message.includes(nonIpService.href) &&
      cause.message.includes('answered no IP address')
    );
  });

  const exit = await readExitAddress(proxy);
  evidence.report.operations.push({
    operation: 'read real proxy exit through declared HTTPS service',
    address: exit,
  });
  assert.equal(
    exit,
    expected,
    'the service must observe the independent fixed proxy exit, not worker egress',
  );
  evidence.report.status = 'passed';
} catch (cause) {
  failure = cause;
  evidence.report.status = 'failed';
  evidence.report.error = cause.stack;
} finally {
  if (declaredService === undefined)
    delete process.env.WELES_PUBLIC_ADDRESS_URL;
  else process.env.WELES_PUBLIC_ADDRESS_URL = declaredService;
  await evidence.finish();
}
if (failure) throw failure;
