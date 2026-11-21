import { decompressed, readAll, streamOf } from './streams'
import { ImportError, type FoundDevice } from './types'
import { zipEntries, zipRead } from './zip'

// UniFi Network encrypts its backups (.unf) with AES-128-CBC under a key and IV that are the same for
// everyone and have long been public (the key is "bcyangkmluohmars"); it keeps accidents out, not people.
const KEY = new TextEncoder().encode('bcyangkmluohmars')
const IV = new TextEncoder().encode('ubntenterpriseap')

/** The largest backup we'll decrypt in memory. */
const MAX_BACKUP = 512 << 20
/** The largest the config dump may be once unpacked. */
const MAX_CONFIG = 256 << 20

/**
 * Decrypts a backup. The data is padded in no way WebCrypto accepts (it insists on PKCS#7), so a block of
 * valid padding is made, by encrypting nothing with the last ciphertext block as the IV, and added; CBC
 * decrypts each block from the one before it, so the rest of the file is unaffected.
 */
async function decrypt(data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new ImportError('This browser can’t read backups (it has no WebCrypto here). Try a support file instead.')
  const key = await subtle.importKey('raw', KEY as BufferSource, 'AES-CBC', false, ['encrypt', 'decrypt'])
  const last = data.subarray(data.length - 16)
  const pad = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: last as BufferSource }, key, new Uint8Array(0)))
  const full = new Uint8Array(data.length + pad.length)
  full.set(data)
  full.set(pad, data.length)
  return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: IV as BufferSource }, key, full))
}

/**
 * Reads the devices from a UniFi Network backup (.unf), in the browser. Only the device table of the
 * configuration is read; the rest of the backup (administrators, networks, passwords) is neither looked at nor kept.
 */
export async function readNetworkBackup(file: Blob, looksLikeOsBackup = false): Promise<FoundDevice[]> {
  if (file.size > MAX_BACKUP || file.size < 32 || file.size % 16 !== 0) throw notABackup(looksLikeOsBackup)
  let plain: Uint8Array
  try {
    plain = await decrypt(new Uint8Array(await file.arrayBuffer()))
  } catch (e) {
    if (e instanceof ImportError) throw e
    throw notABackup(looksLikeOsBackup)
  }
  const entries = plain[0] === 0x50 && plain[1] === 0x4b ? zipEntries(plain) : null
  if (!entries) throw notABackup(looksLikeOsBackup)
  const config = entries.find((e) => e.name === 'db-config.jsonl.gz')
  if (!config) {
    if (entries.some((e) => e.name === 'db.gz')) throw new ImportError('That backup is from an older version of UniFi Network, which this can’t read. Use a support file instead.')
    throw new ImportError("That backup doesn't hold a UniFi Network configuration.")
  }
  const gz = await zipRead(plain, config, MAX_CONFIG)
  const unpacked = gz && (await readAll(decompressed(streamOf(gz), 'gzip'), MAX_CONFIG))
  if (!unpacked) throw new ImportError('That backup’s configuration is too large or damaged to read.')
  return devicesFromConfig(new TextDecoder().decode(unpacked))
}

const notABackup = (os: boolean) =>
  new ImportError(
    os
      ? 'That is a UniFi OS backup (.unifi) of the whole console, which this can’t read. Use a support file, or a UniFi Network backup (.unf).'
      : "That isn't a UniFi Network backup or support file.",
  )

/** The adopted devices in the lines of a backup's configuration dump: "table" lines naming a table and its columns, each followed by that table's "row" lines. */
export function devicesFromConfig(jsonl: string): FoundDevice[] {
  const out: FoundDevice[] = []
  let columns: string[] | null = null
  for (const line of jsonl.split('\n')) {
    if (line === '') continue
    let o: { _t?: string; table?: string; columns?: unknown; v?: unknown }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o._t === 'table') {
      columns = o.table === 'device' && Array.isArray(o.columns) ? (o.columns as string[]) : null
    } else if (o._t === 'row' && columns && Array.isArray(o.v)) {
      const at = (name: string) => o.v && (o.v as unknown[])[columns!.indexOf(name)]
      const model = at('model')
      const type = at('type')
      if (typeof model !== 'string' || typeof type !== 'string' || at('adopted') === false) continue
      out.push({ model, shortname: '', sysid: '', type: type.toLowerCase() })
    }
  }
  return out
}
