import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { apiUrl } from './auth'

/**
 * Files on the gateway: the references the agent hands back, and pulling their
 * bytes down to the phone.
 *
 * There is no structured file field on a transcript row, so the only delivery
 * channel is text: the agent writes `MEDIA:/abs/path` (that is what the Desktop
 * turns into a file card) and the client has to parse it out. Downloads then go
 * through the same REST surface the dashboard uses — `/api/fs/download` for an
 * agent path, `/api/files/download` for the managed tree — authenticated with the
 * session cookie the sign-in already holds.
 */

/** Refuse absurd payloads before base64 inflates them in memory. */
export const MAX_TRANSFER_BYTES = 40 * 1024 * 1024

const MEDIA_PATTERN = /\bMEDIA:\s*([^\s`"'<>]+)/g

export interface MediaRef {
  path: string
  name: string
}

export interface FetchedFile {
  base64: string
  name: string
  mime: string
  size: number
}

/** A file staged onto the gateway, ready to ride along with the next prompt. */
export interface StagedAttachment {
  id: string
  name: string
  /** `@file:` reference the gateway handed back, pasted into the prompt text. */
  refText: string
  kind: 'image' | 'file'
  size: number
}

/** Read a picked file as bare base64 (no data-URL prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`could not read ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

/** Split `MEDIA:` tags out of message text, keeping the prose the user should read. */
export function splitMedia(text: string): { text: string; files: MediaRef[] } {
  const files: MediaRef[] = []
  const seen = new Set<string>()
  const cleaned = text.replace(MEDIA_PATTERN, (_match, rawPath: string) => {
    const path = rawPath.trim().replace(/[.,;:)\]]+$/, '')
    if (path && !seen.has(path)) {
      seen.add(path)
      files.push({ path, name: fileNameOf(path) })
    }
    return ''
  })
  return {
    text: cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    files,
  }
}

export function fileNameOf(path: string): string {
  const clean = path.replace(/[?#].*$/, '').replace(/\/+$/, '')
  const part = clean.split(/[/\\]/).pop() || clean
  try {
    return decodeURIComponent(part) || 'download'
  } catch {
    return part || 'download'
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** `Content-Disposition` → the server's own filename, when it sent one. */
function fileNameFromDisposition(raw: string | undefined): string | null {
  if (!raw) return null
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(raw)
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(raw)
  return plain ? plain[1].trim() : null
}

function dataUrlToFile(dataUrl: string, fallbackName: string): FetchedFile {
  const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('gateway returned a malformed data URL')
  return {
    base64: match[3],
    mime: match[1] || 'application/octet-stream',
    name: fallbackName,
    size: Math.floor((match[3].length * 3) / 4),
  }
}

interface Attempt {
  url: string
  /** `/api/media` answers JSON with a data URL instead of a stream. */
  json?: boolean
}

async function requestBinary(
  attempt: Attempt,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; headers: Record<string, string> } | null> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttpRequest(attempt.url, headers)
    return response
  }
  let response: Response
  try {
    response = await fetch(attempt.url, { headers, credentials: 'include', cache: 'no-store' })
  } catch (err) {
    throw new Error(`network error reaching the gateway (${(err as Error).message})`)
  }
  const raw = await response.arrayBuffer()
  return {
    status: response.status,
    body: base64FromBytes(new Uint8Array(raw)),
    headers: collectHeaders(response.headers),
  }
}

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

async function CapacitorHttpRequest(url: string, headers: Record<string, string>) {
  const res = await CapacitorHttp.request({
    url,
    method: 'GET',
    headers,
    responseType: 'blob',
    connectTimeout: 15_000,
    readTimeout: 60_000,
  })
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(res.headers || {})) {
    out[key.toLowerCase()] = String(value ?? '')
  }
  // responseType 'blob' hands the payload back as base64 text.
  return { status: res.status, body: typeof res.data === 'string' ? res.data : '', headers: out }
}

/**
 * Fetch one file from the gateway as base64.
 *
 * The routes are tried in the order the Desktop uses them; a 404 only means
 * "this build serves it elsewhere", so the next attempt is not a failure.
 */
export async function fetchGatewayFile(options: {
  baseUrl: string
  path: string
  profile: string | null
  sessionId: string | null
  headers: Record<string, string>
}): Promise<FetchedFile> {
  const { baseUrl, path, profile, sessionId, headers } = options
  if (!path) throw new Error('no file path to download')

  const withProfile = (prefix: string) => {
    const params = new URLSearchParams({ path })
    if (profile) params.set('profile', profile)
    if (sessionId) params.set('session_id', sessionId)
    return apiUrl(baseUrl, `${prefix}?${params.toString()}`)
  }

  const attempts: Attempt[] = [
    { url: withProfile('/api/fs/download') },
    { url: withProfile('/api/files/download') },
    { url: withProfile('/api/media'), json: true },
  ]

  let lastError = ''
  for (const attempt of attempts) {
    const response = await requestBinary(attempt, headers)
    if (!response) continue
    if (response.status === 401 || response.status === 403) {
      throw new Error('the gateway refused the download — sign in again')
    }
    if (response.status === 404) {
      lastError = 'not found on the gateway'
      continue
    }
    if (response.status >= 400) {
      lastError = `gateway answered ${response.status}`
      continue
    }

    const declared = Number(response.headers['content-length'] || 0)
    if (declared > MAX_TRANSFER_BYTES) {
      throw new Error(`file is too large for the phone (${Math.round(declared / 1024 / 1024)} MB)`)
    }

    if (attempt.json) {
      const decoded = JSON.parse(
        new TextDecoder().decode(Uint8Array.from(atob(response.body), (c) => c.charCodeAt(0))),
      ) as {
        data_url?: string
        dataUrl?: string
      }
      const dataUrl = decoded.data_url || decoded.dataUrl
      if (!dataUrl) {
        lastError = 'gateway returned no file data'
        continue
      }
      return dataUrlToFile(dataUrl, fileNameOf(path))
    }

    const name =
      fileNameFromDisposition(response.headers['content-disposition']) || fileNameOf(path)
    const mime = (response.headers['content-type'] || 'application/octet-stream').split(';')[0].trim()
    const size = Math.floor((response.body.length * 3) / 4)
    if (size > MAX_TRANSFER_BYTES) {
      throw new Error(`file is too large for the phone (${Math.round(size / 1024 / 1024)} MB)`)
    }
    return { base64: response.body, name, mime, size }
  }

  throw new Error(lastError || 'could not download that file')
}
