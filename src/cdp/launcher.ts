import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';

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
}

const chromiumDefaults = {
  args: [
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-sandbox',
    '--ignore-certificate-errors',
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
    throw new Error(`Chromium binary not found at explicit path: ${explicitPath}`);
  }

  const envPath = process.env.CHROMIUM_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  for (const p of chromiumDefaults.systemPaths) {
    if (existsSync(p)) return p;
  }

  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const result = execSync(`which ${name}`, { encoding: 'utf-8' }).trim();
      if (result) return result;
    } catch {
      // not found, try next
    }
  }

  throw new Error(
    'Could not find a Chromium binary. Set CHROMIUM_PATH or pass chromiumPath in options.'
  );
}

export async function launchChromium(options: LaunchOptions = {}): Promise<LaunchResult> {
  const binary = findChromiumBinary(options.chromiumPath);

  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'weles-'));

  const launchArgs = [...chromiumDefaults.args];

  if (options.headless !== false) {
    launchArgs.push('--headless=new');
  }

  launchArgs.push(`--user-data-dir=${userDataDir}`);

  if (options.proxyServer) {
    launchArgs.push(`--proxy-server=${options.proxyServer}`);
  }

  if (options.args) {
    launchArgs.push(...options.args);
  }

  const child = spawn(binary, launchArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for Chromium DevTools WebSocket URL'));
    }, 30_000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to launch Chromium: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Chromium exited before DevTools URL was found (code=${code}, signal=${signal})`
        )
      );
    });

    const rl = createInterface({ input: child.stderr! });

    rl.on('line', (line) => {
      const match = line.match(/DevTools listening on (ws:\/\/.+)/);
      if (match) {
        clearTimeout(timeout);
        rl.close();
        // Remove the exit listener so normal process lifecycle doesn't reject
        child.removeAllListeners('exit');
        resolve(match[1]);
      }
    });

    rl.on('close', () => {
      // stderr closed before we found the URL — the exit handler or timeout will reject
    });
  });

  return { process: child, wsUrl };
}
