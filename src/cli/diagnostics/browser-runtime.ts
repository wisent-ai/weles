import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  bundledFfmpegPath,
  findPlaywrightManifest,
} from '../../runtime/media-tools.js';

const probeExecutable = promisify(execFile);

type ProbeFailure = Omit<NodeJS.ErrnoException, 'code'> & {
  code?: string | number;
  signal?: NodeJS.Signals | null;
  stderr?: string | Buffer;
};

type RuntimeComponent = {
  name: string;
  revision: string;
  expectedPath: string;
  present: boolean;
  ok: boolean;
  command: string[];
  output?: string;
  error?: string;
  failure?: {
    code?: string;
    errno?: number;
    syscall?: string;
    status?: number | null;
    signal?: NodeJS.Signals | null;
    stderr?: string;
  };
};

type BrowserRuntimeReport = {
  ok: boolean;
  components?: RuntimeComponent[];
  error?: string;
};

/** Probe the bundled encoder Playwright uses for context video, not its install marker. */
export async function inspectBrowserRuntime(): Promise<BrowserRuntimeReport> {
  const report: BrowserRuntimeReport = { ok: false };
  try {
    const manifest = findPlaywrightManifest();
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      browsers?: Array<{ name?: string; revision?: string }>;
    };
    if (!Array.isArray(parsed.browsers))
      throw new Error(`${manifest} carries no browsers list`);
    const declared = parsed.browsers.find((entry) => entry.name === 'ffmpeg');
    if (typeof declared?.revision !== 'string' || !declared.revision.trim())
      throw new Error(`${manifest} declares no ffmpeg revision`);
    const executable = bundledFfmpegPath();
    if (!executable)
      throw new Error(`${manifest} resolves no bundled ffmpeg executable`);
    const command = [executable, '-version'];
    const component: RuntimeComponent = {
      name: 'ffmpeg',
      revision: declared.revision,
      expectedPath: executable,
      present: false,
      ok: false,
      command,
    };
    report.components = [component];
    try {
      const metadata = statSync(executable);
      component.present = metadata.isFile();
      if (!component.present)
        throw new Error(`${executable} is not a regular file`);
      const { stdout } = await probeExecutable(executable, ['-version'], {
        encoding: 'utf8',
      });
      component.output = stdout;
      component.ok = true;
      report.ok = true;
    } catch (cause) {
      const failure = (
        cause instanceof Error ? cause : new Error(String(cause))
      ) as ProbeFailure;
      component.error = `probe ${command.join(' ')}: ${failure.message}; repair the packaged recording runtime`;
      component.failure = {
        code: typeof failure.code === 'string' ? failure.code : undefined,
        errno: failure.errno,
        syscall: failure.syscall,
        status: typeof failure.code === 'number' ? failure.code : undefined,
        signal: failure.signal,
        stderr: failure.stderr?.toString(),
      };
    }
  } catch (cause) {
    report.error = `resolve Playwright recording runtime: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return report;
}
