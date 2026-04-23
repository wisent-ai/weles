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
// Cap per run: 10 screenshots + 1 video + 1 html + 1 ndjson. Files older
// than runStart are ignored (older runs' artifacts).

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const RECORDINGS_ROOT = process.env.RECORDINGS_ROOT ?? 'recordings'
const BUCKET = 'recordings'

export interface ArtifactUrls {
  screenshots: string[]
  video: string | null
  dom: string[]
  logs: string[]
}

const KIND_BY_EXT: Record<string, keyof ArtifactUrls | null> = {
  '.png': 'screenshots',
  '.jpg': 'screenshots',
  '.jpeg': 'screenshots',
  '.webm': 'video' as keyof ArtifactUrls,
  '.mp4': 'video' as keyof ArtifactUrls,
  '.html': 'dom',
  '.ndjson': 'logs',
  '.log': 'logs',
}

const CAPS: Record<string, number> = {
  screenshots: 10,
  video: 1,
  dom: 1,
  logs: 1,
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
  return 'application/octet-stream'
}

export async function uploadArtifacts(
  action: string,
  logId: string,
  runStart: Date,
  opts: { force?: boolean } = {},
): Promise<ArtifactUrls | null> {
  if (!opts.force) return null
  if (!SUPABASE_URL || !SUPABASE_KEY) return null

  const dir = join(RECORDINGS_ROOT, action)
  let entries: string[]
  try { entries = await readdir(dir) } catch { return null }

  // Stat each, keep those newer than runStart (minus 2s fudge for clock skew
  // + trajectory startup) and one of the recognized kinds.
  const since = runStart.getTime() - 2000
  const candidates: Array<{ path: string; name: string; ext: string; kind: keyof ArtifactUrls; mtime: number }> = []
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

  const urls: ArtifactUrls = { screenshots: [], video: null, dom: [], logs: [] }
  const counts: Record<string, number> = { screenshots: 0, video: 0, dom: 0, logs: 0 }

  for (const c of candidates) {
    const kindKey = c.kind as string
    if (counts[kindKey] >= (CAPS[kindKey] ?? 1)) continue
    const storagePath = `${action}/${logId}/${c.name}`
    const ok = await uploadOne(c.path, storagePath, contentTypeFor(c.ext))
    if (!ok) continue
    counts[kindKey]++
    const u = publicUrl(storagePath)
    if (c.kind === 'video') urls.video = u
    else (urls[c.kind] as string[]).push(u)
  }

  // Return null if we didn't actually upload anything so callers can omit the
  // artifacts field from result rather than PATCH an empty object.
  if (counts.screenshots + counts.video + counts.dom + counts.logs === 0) return null
  return urls
}
