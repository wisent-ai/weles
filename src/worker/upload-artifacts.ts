// Uploads trajectory artifacts to the 'recordings' Supabase Storage bucket
// after a run completes. Keyed by action + account_action_logs id so the
// Echo's Artifacts viewer at /accounts/[id]/actions/[log_id] can
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

import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { createHash } from 'node:crypto'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const RECORDINGS_ROOT = process.env.WELES_RECORDINGS_ROOT ?? process.env.RECORDINGS_ROOT ?? 'recordings'
const BUCKET = 'recordings'
const UPLOAD_PROOF_NAME = '.uploaded.json'

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
  // G17: forensic captures — full HAR (request/response + bodies) and the raw
  // packet capture (decryptable with the sibling sslkey.log). Previously
  // excluded by extension; now uploaded so the capture is truly complete.
  '.har': 'logs',
  '.pcap': 'logs',
  '.txt': 'logs',
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

type Kind = 'screenshots' | 'videos' | 'dom' | 'logs'

// Recursively collect every file under a run directory, preserving the path
// relative to it (so the storage layout mirrors the on-disk tree).
async function collectTree(root: string, relBase: string, out: Array<{ path: string; rel: string; ext: string; kind: Kind }>): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>> = []
  try { entries = await readdir(root, { withFileTypes: true } as any) as any } catch { return }
  for (const e of entries as any[]) {
    const name = e.name as string
    // The upload-proof marker belongs to the mirror contract, not to the
    // run's artifacts — never upload it.
    if (name === UPLOAD_PROOF_NAME) continue
    const full = join(root, name)
    const rel = relBase ? `${relBase}/${name}` : name
    if (e.isDirectory()) { await collectTree(full, rel, out); continue }
    const ext = extname(name).toLowerCase()
    // Full capture: never skip by extension — unknown types upload as 'logs'.
    const kind: Kind = (KIND_BY_EXT[ext] ?? 'logs') as Kind
    out.push({ path: full, rel, ext, kind })
  }
}

export async function uploadArtifacts(
  _action: string,
  logId: string,
  _runStart: Date,
  _opts: { force?: boolean } = {},
): Promise<ArtifactUrls | null> {
  // G17: artifacts are keyed by run UUID. Recursively mirror the entire
  // recordings/<run_uuid>/ tree to storage at <run_uuid>/<relative-path>, so
  // EVERYTHING a run produced — across every sub-action/label dir — is uploaded.
  // No extension allowlist filtering (unknown -> logs) and NO per-kind caps:
  // nothing is silently truncated. The per-run dir makes the old mtime window
  // unnecessary (every file under it belongs to this run).
  if (!SUPABASE_URL || !SUPABASE_KEY) return null

  const runDir = join(RECORDINGS_ROOT, logId)
  const files: Array<{ path: string; rel: string; ext: string; kind: Kind }> = []
  await collectTree(runDir, '', files)
  if (files.length === 0) return null

  const urls: ArtifactUrls = { screenshots: [], video: null, videos: [], dom: [], logs: [] }
  let failed = 0
  for (const f of files) {
    const storagePath = `${logId}/${f.rel}`
    const ok = await uploadOne(f.path, storagePath, contentTypeFor(f.ext))
    if (!ok) { failed += 1; continue }
    ;(urls[f.kind] as string[]).push(publicUrl(storagePath))
  }
  // Back-compat alias: .video = newest webm = videos[0]
  urls.video = urls.videos[0] ?? null

  if (urls.screenshots.length + urls.videos.length + urls.dom.length + urls.logs.length === 0) return null
  if (failed === 0) await writeUploadProof(runDir, logId, files)
  return urls
}

// Durable whole-run proof that the local recordings/<run>/ tree is fully
// mirrored to storage. Host cleanup automation may require this marker before
// deleting a run directory. Written only when EVERY collected file uploaded; a
// later write into the run directory invalidates the proof because cleanup
// compares child mtimes against uploaded_at.
async function writeUploadProof(
  runDir: string,
  logId: string,
  files: Array<{ path: string; rel: string }>,
): Promise<void> {
  const manifest: string[] = []
  let totalBytes = 0
  for (const f of files) {
    const info = await stat(f.path).catch(() => null)
    if (!info) return // a collected file vanished mid-upload: no proof
    totalBytes += info.size
    manifest.push(`${f.rel}:${info.size}`)
  }
  manifest.sort()
  const proof = {
    version: 1,
    run: logId,
    uploaded_at: new Date().toISOString(),
    file_count: files.length,
    total_bytes: totalBytes,
    sha256: createHash('sha256').update(manifest.join('\n')).digest('hex'),
    destination: `${BUCKET}/${logId}/`,
  }
  await writeFile(join(runDir, UPLOAD_PROOF_NAME), `${JSON.stringify(proof, null, 2)}\n`, 'utf8')
}
