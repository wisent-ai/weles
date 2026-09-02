// Uploads complete trajectory artifact trees through Stado's authenticated
// product object API. Every artifact remains private under stado://weles/ and
// result rows receive only canonical private locators.
//
// Every file under recordings/<run_uuid>/ belongs to that run and is mirrored
// with its relative path intact. There is no extension allowlist, mtime window,
// or per-kind cap: HAR, PCAP, DOM, logs, screenshots, video, JSON, and unknown
// forensic formats all cross the same private authenticated boundary.
//
// Configuration and upload failures are fatal. A caller may publish locators
// only after Stado acknowledges the exact canonical URI for every object.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import type { ArtifactLocatorSet } from './artifact-delivery.js'

const RECORDINGS_ROOT = process.env.WELES_RECORDINGS_ROOT ?? process.env.RECORDINGS_ROOT ?? 'recordings'
const OBJECT_NAMESPACE = 'weles'
// Product objects Weles may write. `weles` holds the per-run recordings tree;
// `weles-captures` holds the batch capture artifacts (stills, video, sidecars,
// accessibility results) that generic_capture and generic_accessibility_audit
// produce, which are addressed by batch/site/axis rather than by run id.
const OBJECT_NAMESPACES: Record<string, true> = { weles: true, 'weles-captures': true }
const ARTIFACT_PREFIX = 'recordings'
const UPLOAD_PROOF_NAME = '.uploaded.json'

let stadoObjectConfig: { apiUrl: string; token: string } | null = null


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

function requireStadoObjectConfig(): { apiUrl: string; token: string } {
  if (stadoObjectConfig) return stadoObjectConfig
  const rawUrl = String(process.env.STADO_API_URL ?? '').trim()
  const token = String(process.env.WELES_STADO_OBJECT_API_TOKEN ?? '').trim()
  if (!rawUrl) throw new Error('missing required STADO_API_URL')
  if (!token) throw new Error('missing required WELES_STADO_OBJECT_API_TOKEN')
  if (Buffer.byteLength(token) < Number('32')) throw new Error('WELES_STADO_OBJECT_API_TOKEN must contain at least 32 bytes')
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch { throw new Error('STADO_API_URL must be a valid URL') }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('STADO_API_URL must be an origin without credentials, path, query, or fragment')
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('STADO_API_URL must use HTTPS, except for loopback HTTP')
  }
  for (const siblingName of ['WELES_STADO_MODEL_ROUTER_TOKEN', 'WELES_STADO_MEDIA_ROUTER_TOKEN', 'WELES_ARTIFACT_DELIVERY_TOKEN', 'WELES_ARTIFACT_SIGNING_SECRET']) {
    const sibling = String(process.env[siblingName] ?? '').trim()
    if (sibling && sibling === token) throw new Error(`WELES_STADO_OBJECT_API_TOKEN must be distinct from ${siblingName}`)
  }
  stadoObjectConfig = { apiUrl: parsed.origin, token }
  return stadoObjectConfig
}

function privateStadoUri(namespace: string, key: string): string {
  if (!OBJECT_NAMESPACES[namespace]) throw new Error(`invalid Weles object namespace: ${namespace}`)
  const parts = key.split('/')
  if (!key || key.startsWith('/') || key.endsWith('/') || key.includes('\\') || key.includes('\0') || key.includes('?') || key.includes('#')
    || [...key].some(character => character.charCodeAt(Number(false)) < Number('32'))
    || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`invalid Weles object key: ${key}`)
  }
  return `stado://${namespace}/${key}`
}

// namespace is explicit at every call site: the recordings uploader writes into
// `weles`, the capture actions into `weles-captures`, and nothing may invent a
// third namespace without adding it to OBJECT_NAMESPACES above.
export async function putPrivateStadoObject(
  namespace: string,
  key: string,
  body: Uint8Array | string,
  contentType: string,
): Promise<string> {
  const config = requireStadoObjectConfig()
  const uri = privateStadoUri(namespace, key)
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  const response = await fetch(`${config.apiUrl}/api/object?uri=${encodeURIComponent(uri)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(Number('60000')),
  })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`Stado object upload failed (HTTP ${response.status}): ${responseText.slice(Number(false), Number('300'))}`)
  }
  let payload: Record<string, unknown>
  try { payload = JSON.parse(responseText) as Record<string, unknown> } catch {
    throw new Error('Stado object upload returned invalid JSON')
  }
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex')
  const keys = Object.keys(payload).sort().join(',')
  if (keys !== 'bytes,content_type,created,schema,sha256,state,uri'
    || payload.schema !== 'stado.storage-put-receipt.v1'
    || (payload.state !== 'stored' && payload.state !== 'replayed')
    || payload.uri !== uri
    || payload.sha256 !== expectedSha256
    || payload.bytes !== bytes.byteLength
    || payload.content_type !== contentType
    || typeof payload.created !== 'boolean'
    || payload.created !== (payload.state === 'stored')) {
    throw new Error('Stado object upload returned an invalid exact storage receipt')
  }
  return uri
}
export async function readPrivateStadoObjectIdentity(
  uri: string,
  maximumBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < Number('1')) {
    throw new Error('Stado object readback requires a positive safe byte limit')
  }
  let parsed: URL
  try { parsed = new URL(uri) } catch { throw new Error('Stado object readback URI is invalid') }
  if (parsed.protocol !== 'stado:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || privateStadoUri(parsed.hostname, parsed.pathname.slice(Number('1'))) !== uri) {
    throw new Error('Stado object readback URI is not canonical')
  }
  const config = requireStadoObjectConfig()
  const response = await fetch(`${config.apiUrl}/api/object?uri=${encodeURIComponent(uri)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(Number('60000')),
  })
  if (!response.ok || !response.body) {
    const message = await response.text().catch(() => '')
    throw new Error(`Stado object readback failed (HTTP ${response.status}): ${message.slice(Number('0'), Number('300'))}`)
  }
  const hash = createHash('sha256')
  const reader = response.body.getReader()
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > maximumBytes) {
      await reader.cancel()
      throw new Error('Stado object readback exceeded its exact byte limit')
    }
    hash.update(chunk.value)
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function uploadOne(localPath: string, objectKey: string, contentType: string): Promise<string> {
  const body = await readFile(localPath)
  return putPrivateStadoObject(OBJECT_NAMESPACE, objectKey, body, contentType)
}

function contentTypeFor(ext: string): string {
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.html') return 'text/html'
  if (ext === '.json' || ext === '.har') return 'application/json'
  if (ext === '.ndjson') return 'application/x-ndjson'
  if (ext === '.pcap') return 'application/vnd.tcpdump.pcap'
  if (ext === '.log' || ext === '.txt' || ext === '.patch') return 'text/plain'
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

export async function uploadArtifacts(logId: string): Promise<ArtifactLocatorSet | null> {
  // Artifacts are keyed by run UUID. Recursively mirror the entire
  // recordings/<run_uuid>/ tree to stado://weles/recordings/<run_uuid>/,
  // preserving every relative path and file type without per-kind caps.
  requireStadoObjectConfig()

  const runDir = join(RECORDINGS_ROOT, logId)
  const files: Array<{ path: string; rel: string; ext: string; kind: Kind }> = []
  await collectTree(runDir, '', files)
  if (!files.length) return null

  const locators: ArtifactLocatorSet = { screenshots: [], videos: [], dom: [], logs: [] }
  for (const f of files) {
    const objectKey = `${ARTIFACT_PREFIX}/${logId}/${f.rel}`
    const locator = await uploadOne(f.path, objectKey, contentTypeFor(f.ext))
    ;(locators[f.kind] as string[]).push(locator)
  }

  if (!(locators.screenshots.length + locators.videos.length + locators.dom.length + locators.logs.length)) return null
  await writeUploadProof(runDir, logId, files)
  return locators
}

// Durable whole-run proof that the local recordings/<run>/ tree is fully
// mirrored to private Stado objects. The Stado weles_recordings cleaner
// requires this marker before it may delete a run directory (unless the host
// explicitly opts into allow_missing_upload_proof). Written only after every
// collected file has been acknowledged with its exact canonical URI. A later
// write into the run directory invalidates the proof, because the cleaner
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
    destination: `${privateStadoUri(OBJECT_NAMESPACE, `${ARTIFACT_PREFIX}/${logId}`)}/`,
  }
  await writeFile(join(runDir, UPLOAD_PROOF_NAME), `${JSON.stringify(proof, null, 2)}\n`, 'utf8')
}
