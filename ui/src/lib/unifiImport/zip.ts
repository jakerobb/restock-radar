import { decompressed, readAll, streamOf } from './streams'

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  offset: number
}

const u16 = (d: DataView, at: number) => d.getUint16(at, true)
const u32 = (d: DataView, at: number) => d.getUint32(at, true)

/** The entries of a zip, found by its central directory. Anything after the directory's end (a decrypted backup is padded) is ignored; null when it isn't a zip. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-directory record is within 64 KiB of the end (its comment is at most that long).
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = u16(view, eocd + 10)
  let at = u32(view, eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || u32(view, at) !== 0x02014b50) return null
    const nameLen = u16(view, at + 28)
    const extraLen = u16(view, at + 30)
    const commentLen = u16(view, at + 32)
    entries.push({
      method: u16(view, at + 10),
      compressedSize: u32(view, at + 20),
      size: u32(view, at + 24),
      offset: u32(view, at + 42),
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen)),
    })
    at += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** An entry's contents, or null when it is larger than `limit` or can't be read. */
export async function zipRead(bytes: Uint8Array, entry: ZipEntry, limit: number): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = entry.offset
  if (at + 30 > bytes.length || u32(view, at) !== 0x04034b50) return null
  const start = at + 30 + u16(view, at + 26) + u16(view, at + 28)
  const raw = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw.length <= limit ? raw : null
  if (entry.method !== 8) return null
  return readAll(decompressed(streamOf(raw), 'deflate-raw'), limit)
}
