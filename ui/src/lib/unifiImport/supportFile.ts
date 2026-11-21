import { ByteReader, decompressed } from './streams'
import { ImportError, type FoundDevice } from './types'

/** The largest devices.json we'll read; a big site's is a few megabytes. */
const MAX_DEVICES_JSON = 64 << 20
/** The file we want, in a support file made by a UniFi Network application. */
const WANTED = /(^|\/)unifi\/devices\.json$/

const text = (b: Uint8Array, from: number, len: number): string => {
  const slice = b.subarray(from, from + len)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end))
}

/** The path a pax extended header gives ("27 path=a/b\n"), if it gives one. */
function paxPath(data: Uint8Array): string | undefined {
  for (const record of new TextDecoder().decode(data).split('\n')) {
    const m = /^\d+ path=(.*)$/.exec(record)
    if (m) return m[1]
  }
  return undefined
}

/**
 * Reads the devices from a UniFi support file (a gzipped tar), in the browser. It is streamed: everything
 * but the one file with the device list is read past and dropped, and reading stops as soon as that is found,
 * so a support file of a gigabyte costs no more memory than one of a megabyte.
 */
export async function readSupportFile(file: Blob): Promise<FoundDevice[]> {
  const reader = new ByteReader(decompressed(file.stream() as ReadableStream<Uint8Array>, 'gzip'))
  try {
    let longName: string | undefined
    for (;;) {
      const header = await reader.read(512)
      if (header.length < 512 || header.every((b) => b === 0)) break
      let name = text(header, 0, 100)
      if (text(header, 257, 5) === 'ustar') {
        const prefix = text(header, 345, 155)
        if (prefix !== '') name = `${prefix}/${name}`
      }
      const size = parseInt(text(header, 124, 12).trim() || '0', 8)
      if (!Number.isFinite(size) || size < 0) throw new ImportError("That isn't a support file (its archive is damaged).")
      const type = String.fromCharCode(header[156] ?? 0)
      const padded = Math.ceil(size / 512) * 512
      if (type === 'L' || type === 'x') {
        // A long name, or extended attributes, for the entry that follows.
        const data = await reader.read(size)
        await reader.skip(padded - size)
        const given = type === 'L' ? text(data, 0, data.length) : paxPath(data)
        if (given !== undefined) longName = given
        continue
      }
      if (longName !== undefined) name = longName
      longName = undefined
      if ((type === '0' || type === '\0') && WANTED.test(name)) {
        if (size > MAX_DEVICES_JSON) throw new ImportError('That support file’s device list is too large to read.')
        const data = await reader.read(size)
        if (data.length < size) throw new ImportError("That isn't a support file (it ends too soon).")
        return devicesFromJson(new TextDecoder().decode(data))
      }
      if (!(await reader.skip(padded))) break
    }
  } catch (e) {
    if (e instanceof ImportError) throw e
    throw new ImportError("That file couldn't be read as a support file.")
  } finally {
    await reader.cancel()
  }
  throw new ImportError('That support file has no UniFi Network device list. Make one from UniFi Network (Settings, System, Support File) and include UniFi Network.')
}

/** The devices in the text of a support file's devices.json: a list of sites, each a list of devices. */
export function devicesFromJson(json: string): FoundDevice[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new ImportError("That support file's device list isn't readable.")
  }
  const out: FoundDevice[] = []
  collect(parsed, out, 0)
  return out
}

function collect(v: unknown, out: FoundDevice[], depth: number): void {
  if (depth > 4 || typeof v !== 'object' || v === null) return
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out, depth + 1)
    return
  }
  const o = v as Record<string, unknown>
  if (typeof o.model === 'string' && typeof o.type === 'string') {
    // A device the console knows but hasn't adopted isn't equipment in use.
    if (o.adopted === false) return
    out.push({
      model: o.model,
      shortname: typeof o.shortname === 'string' ? o.shortname : '',
      sysid: typeof o.sysid === 'number' && Number.isInteger(o.sysid) && o.sysid >= 0 ? o.sysid.toString(16).padStart(4, '0') : '',
      type: o.type.toLowerCase(),
    })
    return
  }
  for (const x of Object.values(o)) collect(x, out, depth + 1)
}
