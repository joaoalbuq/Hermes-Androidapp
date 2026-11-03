import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Writing a downloaded file into the phone's own storage.
 *
 * On Android this is the native `Downloads` plugin: it inserts the row through
 * MediaStore on API 29+ (or writes the legacy public Download folder below that),
 * so the file lands in the same place the browser would put it and shows up in
 * Files / Downloads without the app needing broad storage access.
 *
 * In a desktop browser there is no such plugin, so the bytes become a blob and a
 * normal `<a download>` click — that is the development path, not the phone path.
 */

interface DownloadsPlugin {
  save(options: { filename: string; mime: string; base64: string }): Promise<{
    name: string
    location: string
    bytes: number
    uri: string
  }>
}

const Downloads = registerPlugin<DownloadsPlugin>('Downloads')

export interface SavedFile {
  name: string
  /** Human-readable destination, for the confirmation banner. */
  location: string
}

export function canSaveToDevice(): boolean {
  return Capacitor.isNativePlatform()
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function saveBase64File(
  filename: string,
  mime: string,
  base64: string,
): Promise<SavedFile> {
  if (Capacitor.isNativePlatform()) {
    const saved = await Downloads.save({
      filename,
      mime: mime || 'application/octet-stream',
      base64,
    })
    return { name: saved.name || filename, location: saved.location || 'Downloads' }
  }

  const bytes = decodeBase64(base64)
  // Copy into a fresh ArrayBuffer: BlobPart wants a plain buffer, and a
  // Uint8Array view would otherwise be interpreted as the whole backing store.
  const blob = new Blob([bytes.slice().buffer], { type: mime || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { name: filename, location: 'this device’s downloads' }
}
