// Uploads trajectory artifacts to the 'recordings' Supabase Storage bucket
// after a run completes. Keyed by action + account_action_logs id so the
// content-platform Artifacts viewer at /accounts/[id]/actions/[log_id] can
// render them from direct storage URLs.
//
// Volume control: only uploads when the caller passes opts.force=true (worker
// uses this for failures + health probes that flipped unhealthy). The happy
// path never uploads — that's where the volume is, and you rarely need
// recordings for a clean tick.
//
// Cap per run: 50 screenshots + 50 videos + 100 dom + 100 logs. videos was
// previously capped at 1 — but Playwright writes one .webm PER PAGE in the
// context, so trajectories that open multiple pages produced multiple webms
// on disk and only the newest reached storage, hiding everything before the
// last page. dom + logs were also capped at 1 which dropped every DOM dump
// except the newest and dropped per-step network ndjson files — both kinds
// are small text and capping them defeats the no-truncation rule that the
// byte-by-byte net_record.ts capture was wired in to satisfy. Files older
// than runStart are ignored (older runs' artifacts).

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT ?? 'recordings'
const BUCKET = 'recordings'

export interface ArtifactUrls {
  screenshots: string[]
  // video: the newest webm uploaded — kept for backwards compat with
  // existing readers (Artifacts viewer, ban-attribution heuristics).
  video: string | null
  // videos: every webm uploaded for the run, newest-first. New code should
  // prefer this over .video. The .video field aliases videos[0].
  videos: string[]
  dom: string[]
  logs: string[]
}

const KIND_BY_EXT: Record<string, 'screenshots' | 'videos' | 'dom' | 'logs' | null> = {
  '.png': 'screenshots',
  '.jpg': 'screenshots',
  '.jpeg': 'screenshots',
  '.webm': 'videos',
  '.mp4': 'videos',
  '.html': 'dom',
  '.ndjson': 'logs',
  '.log': 'logs',
  // The merged fingerprint dump written by net_record.ts + finalize.ts —
  // accesses, requests, console, pageerrors, persona, proxy, versions in
  // one file. Uploaded as a 'logs' artifact so it appears in the existing
  // /weles inspection UI's logs column without a schema change.
  '.json': 'logs',
  // G5: source_diff.patch — the full `git diff` captured when a run executed
  // against a dirty repo/trajectory. Uploaded as 'logs' so the exact uncommitted
  // source that produced the row is recoverable from storage.
  '.patch': 'logs',
}

const CAPS: Record<string, number> = {
  screenshots: 50,
  videos: 50,
  dom: 100,
  logs: 100,
}

function publicUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`
}

async function uploadOne(localPath: string, storagePath: string, contentType: string): Promise<boolean> {
  try {
    const body = await readFile(localPath)
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body,
      },
    )
    return res.ok
  } catch {
    return false
  }
}

function contentTypeFor(ext: string): string {
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.html') return 'text/html'
  if (ext === '.json') return 'application/json'
  if (ext === '.ndjson') return 'application/x-ndjson'
  return 'application/octet-stream'
}

export async function uploadArtifacts(
  action: string,
  logId: string,
  runStart: Date,
  _opts: { force?: boolean } = {},
): Promise<ArtifactUrls | null> {
  // Was gated behind opts.force=true — only failures + health flips uploaded,
  // happy paths skipped. The standing "ALL FINGERPRINTS, no truncation" rule
  // means every run's full inst dump needs to be in Supabase Storage so the
  // /weles inspection UI can render it, not just the failure paths. The opts
  // arg is retained for callsite compatibility but no longer gates upload.
  if (!SUPABASE_URL || !SUPABASE_KEY) return null

  const dir = join(RECORDINGS_ROOT, action)
  let entries: string[]
  try { entries = await readdir(dir) } catch { return null }

  // Stat each, keep those newer than runStart (minus 2s fudge for clock skew
  // + trajectory startup) and one of the recognized kinds.
  const since = runStart.getTime() - 2000
  type Kind = 'screenshots' | 'videos' | 'dom' | 'logs'
  const candidates: Array<{ path: string; name: string; ext: string; kind: Kind; mtime: number }> = []
  for (const name of entries) {
    const ext = extname(name).toLowerCase()
    const kind = KIND_BY_EXT[ext]
    if (!kind) continue
    const full = join(dir, name)
    try {
      const s = await stat(full)
      if (s.mtimeMs < since) continue
      candidates.push({ path: full, name, ext, kind, mtime: s.mtimeMs })
    } catch { /* skip */ }
  }
  // Newest first so caps keep the latest files per kind.
  candidates.sort((a, b) => b.mtime - a.mtime)

  const urls: ArtifactUrls = { screenshots: [], video: null, videos: [], dom: [], logs: [] }
  const counts: Record<Kind, number> = { screenshots: 0, videos: 0, dom: 0, logs: 0 }

  for (const c of candidates) {
    if (counts[c.kind] >= (CAPS[c.kind] ?? 1)) continue
    const storagePath = `${action}/${logId}/${c.name}`
    const ok = await uploadOne(c.path, storagePath, contentTypeFor(c.ext))
    if (!ok) continue
    counts[c.kind]++
    const u = publicUrl(storagePath)
    ;(urls[c.kind] as string[]).push(u)
  }
  // Back-compat alias: .video = newest webm = videos[0]
  urls.video = urls.videos[0] ?? null

  if (counts.screenshots + counts.videos + counts.dom + counts.logs === 0) return null
  return urls
}
