// The machine a run executed on: its user, interface addresses, a stable
// machine id, its hardware, and its public address asked directly, never
// through a run's proxy. A part that cannot be read is recorded, not guessed.
import { readFileSync } from 'node:fs';
import {
  cpus,
  hostname,
  networkInterfaces,
  release,
  totalmem,
  userInfo,
} from 'node:os';
import {
  parsePublicAddress,
  publicAddressService,
} from '../../utils/runtime/public-address.js';
import { captureFailure, captureFailures, safeExec } from './failures.js';

/** Where each platform keeps a machine id that survives reboots. */
const MACHINE_ID_READERS: Readonly<
  Record<string, (field: string) => string | undefined>
> = Object.freeze({
  linux: (field: string) => {
    let id: string | undefined;
    try {
      id = readFileSync('/etc/machine-id', 'utf8').trim();
    } catch (error) {
      captureFailures.push(
        captureFailure(field, 'read /etc/machine-id', error),
      );
    }
    return id;
  },
  darwin: (field: string) =>
    safeExec(
      `ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}'`,
      field,
    ),
});

function workerUser(): string | undefined {
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch (error) {
    captureFailures.push(captureFailure('worker_user', 'os.userInfo()', error));
  }
  return user;
}

type InterfaceAddress = {
  iface: string;
  address: string;
  mac: string;
  family: string;
};

function localAddresses(): InterfaceAddress[] {
  const out: InterfaceAddress[] = [];
  try {
    for (const [iface, addresses] of Object.entries(networkInterfaces())) {
      if (!addresses) continue;
      for (const entry of addresses) {
        if (entry.internal) continue;
        out.push({
          iface,
          address: entry.address,
          mac: entry.mac,
          family: String(entry.family),
        });
      }
    }
  } catch (error) {
    captureFailures.push(
      captureFailure('machine.local_ips', 'os.networkInterfaces()', error),
    );
  }
  return out;
}

function machineId(): string | undefined {
  const field = 'machine.machine_id';
  const reader = MACHINE_ID_READERS[process.platform];
  if (reader) return reader(field);
  captureFailures.push(
    captureFailure(
      field,
      'read machine id',
      new Error(`no machine id source is known for ${process.platform}`),
    ),
  );
  return undefined;
}

let publicAddress: string | undefined;

/** Ask once, at load, in the long-lived worker, so no run waits on it. */
async function readPublicAddress(): Promise<void> {
  const field = 'machine.public_ip';
  let operation = 'resolve WELES_PUBLIC_ADDRESS_URL';
  try {
    const service = publicAddressService();
    operation = `GET ${service}`;
    const response = await fetch(service);
    const text = await response.text();
    if (!response.ok)
      throw new Error(`answered HTTP ${response.status}: ${text}`);
    publicAddress = parsePublicAddress(text, service);
  } catch (error) {
    captureFailures.push(captureFailure(field, operation, error));
  }
}
void readPublicAddress();

/** The machine's identity read once for this process. */
export function machineIdentity(): Record<string, unknown> {
  const [cpu] = cpus();
  return {
    hostname: hostname(),
    user: workerUser(),
    platform: process.platform,
    arch: process.arch,
    os_release: release(),
    cpu_model: cpu?.model,
    cpu_count: cpus().length,
    total_mem_bytes: totalmem(),
    local_ips: localAddresses(),
    machine_id: machineId(),
    pid: process.pid,
  };
}

/** The public address once its one request answered; absent before, and after a recorded failure. */
export function machinePublicAddress(): string | undefined {
  return publicAddress;
}
