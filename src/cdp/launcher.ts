import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface LaunchOptions {
  headless?: boolean;
  args?: string[];
  userDataDir?: string;
  proxyServer?: string;
  chromiumPath?: string;
}

export interface LaunchResult {
  process: ChildProcess;
  wsUrl: string;
  proxyAuth?: { username: string; password: string };
}

const chromiumDefaults = {
  args: [
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-sandbox',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-popup-blocking',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--force-color-profile=srgb',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-back-forward-cache',
    '--disable-breakpad',
    '--disable-dev-shm-usage',
    '--allow-pre-commit-input',
  ],

  systemPaths: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
};

function findChromiumBinary(explicitPath?: string): string {
  if (explicitPath) {
    if (existsSync(explicitPath)) return explicitPath;
    throw new Error(
      `Chromium binary not found at explicit path: ${explicitPath}`,
    );
  }

  // A CHROMIUM_PATH that names no file is a misconfiguration, not a hint to look elsewhere.
  const envPath = process.env.CHROMIUM_PATH;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    throw new Error(`CHROMIUM_PATH names ${envPath}, which does not exist`);
  }

  for (const p of chromiumDefaults.systemPaths) {
    if (existsSync(p)) return p;
  }

  // `which` answers the binary's path on PATH and fails when there is none.
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf-8' });
    const path = found.stdout.trim();
    if (!found.status && path) return path;
  }

  throw new Error(
    'Could not find a Chromium binary. Set CHROMIUM_PATH or pass chromiumPath in options.',
  );
}

export async function launchChromium(
  options: LaunchOptions = {},
): Promise<LaunchResult> {
  const binary = findChromiumBinary(options.chromiumPath);

  const userDataDir =
    options.userDataDir ?? mkdtempSync(join(tmpdir(), 'weles-'));

  const launchArgs = [...chromiumDefaults.args];

  if (options.headless !== false) {
    launchArgs.push('--headless=new');
  }

  launchArgs.push(`--user-data-dir=${userDataDir}`);

  let proxyAuth: { username: string; password: string } | undefined;
  if (options.proxyServer) {
    // Chrome takes the proxy without its credentials; a URL carrying them is
    // split, and one it cannot parse (host:port) is handed over as given.
    const pu = URL.canParse(options.proxyServer)
      ? new URL(options.proxyServer)
      : null;
    if (pu && pu.username) {
      proxyAuth = {
        username: decodeURIComponent(pu.username),
        password: decodeURIComponent(pu.password),
      };
      launchArgs.push(`--proxy-server=${pu.protocol}//${pu.host}`);
    } else {
      launchArgs.push(`--proxy-server=${options.proxyServer}`);
    }
  }

  if (options.args) {
    launchArgs.push(...options.args);
  }

  const child = spawn(binary, launchArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Chromium either prints its DevTools URL or exits; both are answers, and
  // the exit carries its code and signal into the error.
  const wsUrl = await new Promise<string>((resolve, reject) => {
    child.on('error', (err) => {
      reject(new Error(`Failed to launch Chromium: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      reject(
        new Error(
          `Chromium exited before DevTools URL was found (code=${code}, signal=${signal})`,
        ),
      );
    });

    const rl = createInterface({ input: child.stderr! });

    rl.on('line', (line) => {
      const match = line.match(/DevTools listening on (?<url>ws:\/\/.+)/);
      if (match?.groups) {
        rl.close();
        // Remove the exit listener so normal process lifecycle doesn't reject
        child.removeAllListeners('exit');
        resolve(match.groups.url);
      }
    });
  });

  return { process: child, wsUrl, proxyAuth };
}
