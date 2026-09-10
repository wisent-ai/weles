import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsRoot } from '../session/run-recordings.js';
import { diagnoseCapture } from './diagnosis.js';

// ---------------------------------------------------------------------------
// Minimal type interfaces
// ---------------------------------------------------------------------------

export interface CDPPage {
  send(method: string, params?: Record<string, any>): Promise<any>;
  on(event: string, cb: (params: any) => void): void;
  off(event: string, cb: (params: any) => void): void;
  screenshot?(options?: { type?: string }): Promise<Buffer>;
  url?(): string;
}

export interface CDPBrowserContext {
  newPage(): Promise<CDPPage>;
}

export interface ResponseRecord {
  url: string;
  method: string;
  status: number;
  body: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}


// ---------------------------------------------------------------------------
// Capture class
// ---------------------------------------------------------------------------

export class Capture {
  private _context: CDPBrowserContext;
  private _outDir?: string;
  consoleLogs: string[] = [];
  responseBodies: ResponseRecord[] = [];
  constructor(context: CDPBrowserContext, outputDir?: string) { this._context = context; this._outDir = outputDir; }
  private _dir(...segs: string[]): string { const d = join(this._outDir ?? runRecordingsRoot(), ...segs); mkdirSync(d, { recursive: true }); return d; }

  // -----------------------------------------------------------------------
  // Page creation with automatic logging
  // -----------------------------------------------------------------------

  async newPage(): Promise<CDPPage> {
    const page = await this._context.newPage();

    // Console logging
    page.on('Runtime.consoleAPICalled', (params: any) => {
      const args = (params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ');
      const level = params.type ?? 'log';
      this.consoleLogs.push(`[${level}] ${args}`);
    });

    // Enable Runtime domain so we receive console events
    await page.send('Runtime.enable').catch(() => {});

    // Network response logging
    page.on('Network.responseReceived', (params: any) => {
      const resp = params.response ?? {};
      const req = params.request ?? {};
      const requestId: string = params.requestId;

      // Attempt to fetch the body (best-effort, will fail for streaming / ws)
      page
        .send('Network.getResponseBody', { requestId })
        .then((bodyResult: any) => {
          this.responseBodies.push({
            url: resp.url ?? req.url ?? '',
            method: req.method ?? 'GET',
            status: resp.status ?? 0,
            body: bodyResult?.body ?? '',
          });
        })
        .catch(() => {
          this.responseBodies.push({
            url: resp.url ?? req.url ?? '',
            method: req.method ?? 'GET',
            status: resp.status ?? 0,
            body: '',
          });
        });
    });

    await page.send('Network.enable').catch(() => {});

    return page;
  }

  // -----------------------------------------------------------------------
  // Screenshot
  // -----------------------------------------------------------------------

  async screenshot(page: CDPPage, label: string): Promise<string> {
    const dir = this._dir();
    const filename = `${label}_${timestamp()}.png`;
    const filePath = join(dir, filename);

    let buf: Buffer;
    if (typeof page.screenshot === 'function') {
      buf = await page.screenshot({ type: 'png' });
    } else {
      const result = await page.send('Page.captureScreenshot', { format: 'png' });
      buf = Buffer.from(result.data, 'base64');
    }

    writeFileSync(filePath, buf);
    return filePath;
  }

  // -----------------------------------------------------------------------
  // DOM capture (including iframes)
  // -----------------------------------------------------------------------

  async captureDom(page: CDPPage, label: string): Promise<string | null> {
    const dir = this._dir();
    try {
      const r = await page.send('DOM.getDocument', { depth: -1, pierce: true });
      const root = r?.root;
      if (root) {
        const h = await page.send('DOM.getOuterHTML', { nodeId: root.nodeId });
        const fp = join(dir, `${label}_dom_${timestamp()}.json`);
        writeFileSync(fp, JSON.stringify({ tree: root, outerHTML: h?.outerHTML ?? '' }, null, 2));
        return fp;
      }
    } catch { /* CDP unavailable on Firefox; use Playwright content() below */ }
    try {
      const html = await (page as any).content?.();
      if (typeof html === 'string') {
        const fp = join(dir, `${label}_dom_${timestamp()}.html`);
        writeFileSync(fp, html);
        return fp;
      }
    } catch { /* page closed */ }
    return null;
  }

  // -----------------------------------------------------------------------
  // Environment capture
  // -----------------------------------------------------------------------

  async captureEnvironment(page: CDPPage): Promise<any> {
    const collectScript = `(() => {
      return {
        url: location.href,
        title: document.title,
        cookies: document.cookie,
        localStorage: (() => { try { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; } catch { return null; } })(),
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        timestamp: new Date().toISOString(),
      };
    })()`;

    const evalResult = await page.send('Runtime.evaluate', {
      expression: collectScript,
      returnByValue: true,
      awaitPromise: false,
    });

    const value = evalResult?.result?.value ?? null;

    const dir = this._dir();
    const filename = `environment_${timestamp()}.json`;
    const filePath = join(dir, filename);
    writeFileSync(filePath, JSON.stringify(value, null, 2));

    return value;
  }

  // -----------------------------------------------------------------------
  // Save all artefacts to disk
  // -----------------------------------------------------------------------

  async save(label: string, page?: CDPPage): Promise<Record<string, string>> {
    const dir = this._dir();
    const ts = timestamp();
    const paths: Record<string, string> = {};

    // Console logs
    const consolePath = join(dir, `${label}_console_${ts}.log`);
    writeFileSync(consolePath, this.consoleLogs.join('\n'));
    paths.console = consolePath;

    // Response bodies
    const responsesPath = join(dir, `${label}_responses_${ts}.json`);
    writeFileSync(responsesPath, JSON.stringify(this.responseBodies, null, 2));
    paths.responses = responsesPath;

    // DOM snapshot (optional — only if page supplied)
    if (page) {
      const domPath = await this.captureDom(page, label);
      if (domPath) {
        paths.dom = domPath;
      }
    }

    return paths;
  }

  // -----------------------------------------------------------------------
  // Diagnose via video + artefact analysis
  // -----------------------------------------------------------------------

  async diagnose(
    videoPath: string,
    consolePath?: string,
    responsesPath?: string,
    domPath?: string,
  ): Promise<string> {
    return diagnoseCapture(this._dir('diagnosis_frames'), videoPath, consolePath, responsesPath, domPath);
  }

  // -----------------------------------------------------------------------
  // Full finish workflow
  // -----------------------------------------------------------------------

  async finish(
    label: string,
    options?: { page?: CDPPage; videoPath?: string },
  ): Promise<{ paths: Record<string, string>; diagnosis: string; trafficDiff: ResponseRecord[] }> {
    const page = options?.page;
    const paths = await this.save(label, page);

    let diagnosis = '';
    if (options?.videoPath) {
      diagnosis = await this.diagnose(options.videoPath, paths.console, paths.responses, paths.dom);
    }

    const trafficDiff = this.responseBodies.filter((r) => r.status < 200 || r.status >= 300);
    return { paths, diagnosis, trafficDiff };
  }
}
