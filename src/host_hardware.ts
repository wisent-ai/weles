import { cpus, platform, release, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';

export interface HostScreen {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  availTop: number;
  colorDepth: number;
  dpr: number;
}

export interface HostHardware {
  osFamily: 'macos' | 'windows' | 'linux' | 'unknown';
  cores: number;
  deviceMemory: number;
  osVersion: string | null;
  platformVersion: string | null;
  chip: string | null;
  glRenderer: string | null;
  glUnmaskedVendor: string | null;
  screen: HostScreen | null;
}

let cached: HostHardware | null = null;

export function honestHostEnabled(): boolean {
  const value = String(process.env.WELES_HONEST_HOST ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(value);
}

export function hostHardware(): HostHardware {
  if (cached) return cached;
  const osFamily = detectOsFamily();
  const osVersion = detectOsVersion(osFamily);
  const chip = detectChip(osFamily);
  cached = {
    osFamily,
    cores: Math.max(1, cpus().length || 1),
    deviceMemory: detectDeviceMemoryGb(),
    osVersion,
    platformVersion: osFamily === 'macos' ? macPlatformVersion(osVersion) : osVersion,
    chip,
    glRenderer: detectGlRenderer(osFamily, chip),
    glUnmaskedVendor: detectGlVendor(osFamily, chip),
    screen: detectScreen(osFamily),
  };
  return cached;
}

function detectOsFamily(): HostHardware['osFamily'] {
  const p = platform();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  if (p === 'linux') return 'linux';
  return 'unknown';
}

function detectDeviceMemoryGb(): number {
  const gb = totalmem() / 1024 / 1024 / 1024;
  if (!Number.isFinite(gb) || gb <= 0) return 8;
  if (gb <= 4) return Math.max(1, Math.round(gb));
  // Chrome's JS-exposed navigator.deviceMemory is coarse and capped; on this
  // 64 GB macOS host, real Chrome 147 reports 32, not 64.
  return Math.min(32, Math.max(1, Math.round(gb)));
}

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function detectOsVersion(osFamily: HostHardware['osFamily']): string | null {
  if (osFamily === 'macos') return run('sw_vers', ['-productVersion']) || release();
  return release() || null;
}

function macPlatformVersion(osVersion: string | null): string | null {
  if (!osVersion) return null;
  const parts = osVersion.split('.').filter(Boolean);
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

function detectChip(osFamily: HostHardware['osFamily']): string | null {
  if (osFamily === 'macos') {
    return run('sysctl', ['-n', 'machdep.cpu.brand_string'])
      || run('sysctl', ['-n', 'hw.model'])
      || null;
  }
  return cpus()[0]?.model || null;
}

function detectGlRenderer(osFamily: HostHardware['osFamily'], chip: string | null): string | null {
  if (osFamily === 'macos') {
    const renderer = chip || 'Apple GPU';
    if (/apple/i.test(renderer)) return `ANGLE (Apple, ANGLE Metal Renderer: ${renderer}, Unspecified Version)`;
    if (/intel/i.test(renderer)) return `ANGLE (Intel, ${renderer}, OpenGL 4.1)`;
    if (/amd|radeon/i.test(renderer)) return `ANGLE (AMD, ${renderer}, OpenGL 4.1)`;
    return `ANGLE (Apple, ANGLE Metal Renderer: ${renderer}, Unspecified Version)`;
  }
  if (osFamily === 'windows' && chip) return `ANGLE (Intel, ${chip} Direct3D11 vs_5_0 ps_5_0, D3D11)`;
  if (osFamily === 'linux' && chip) return `Mesa ${chip}`;
  return null;
}

function detectGlVendor(osFamily: HostHardware['osFamily'], chip: string | null): string | null {
  if (osFamily === 'macos') {
    if (chip && /intel/i.test(chip)) return 'Google Inc. (Intel)';
    if (chip && /amd|radeon/i.test(chip)) return 'Google Inc. (AMD)';
    return 'Google Inc. (Apple)';
  }
  if (osFamily === 'windows') return 'Google Inc. (Intel)';
  if (osFamily === 'linux') return 'Intel Open Source Technology Center';
  return null;
}

function detectScreen(osFamily: HostHardware['osFamily']): HostScreen | null {
  if (osFamily !== 'macos') return null;
  const json = run('osascript', [
    '-l',
    'JavaScript',
    '-e',
    [
      'ObjC.import("AppKit");',
      'const s=$.NSScreen.mainScreen;',
      'const f=s.frame;',
      'const vf=s.visibleFrame;',
      'const dpr=s.backingScaleFactor;',
      'JSON.stringify({width:f.size.width,height:f.size.height,availWidth:vf.size.width,availHeight:vf.size.height,availTop:f.size.height-vf.size.height-vf.origin.y,dpr});',
    ].join(' '),
  ]);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<HostScreen>;
    const width = Math.round(Number(parsed.width));
    const height = Math.round(Number(parsed.height));
    const availWidth = Math.round(Number(parsed.availWidth));
    const availHeight = Math.round(Number(parsed.availHeight));
    const availTop = Math.round(Number(parsed.availTop ?? 33));
    const dpr = Number(parsed.dpr) || 1;
    if (!width || !height || !availWidth || !availHeight) return null;
    return {
      width,
      height,
      availWidth,
      availHeight,
      availTop,
      colorDepth: 30,
      dpr,
    };
  } catch {
    return null;
  }
}
