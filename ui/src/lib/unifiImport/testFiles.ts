// Builders for the files a UniFi console makes, with made-up contents, so the readers can be tested without a real one.
import { Blob as NodeBlob } from 'node:buffer'
import { createCipheriv } from 'node:crypto'
import { deflateRawSync, gzipSync } from 'node:zlib'

const enc = new TextEncoder()
const bytes = (d: string | Uint8Array): Uint8Array => (typeof d === 'string' ? enc.encode(d) : d)

/** A Blob that has .stream(), which the one the test environment provides doesn't. */
export const blobOf = (data: Uint8Array, name = ''): Blob & { name: string } => Object.assign(new NodeBlob([data as unknown as Uint8Array<ArrayBuffer>]) as unknown as Blob, { name })

export interface Entry {
  name: string
  data: string | Uint8Array
}

function tarHeader(name: string, size: number, type = '0'): Uint8Array {
  const h = new Uint8Array(512)
  h.set(enc.encode(name.slice(0, 100)), 0)
  h.set(enc.encode(size.toString(8).padStart(11, '0')), 124)
  h[156] = type.charCodeAt(0)
  h.set(enc.encode('ustar'), 257)
  return h
}

const padTo512 = (d: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(d.length / 512) * 512)
  out.set(d)
  return out
}

/** A tar of the entries; a name longer than 100 characters goes in a GNU long-name entry, as GNU tar does it. */
export function tar(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const e of entries) {
    const data = bytes(e.data)
    if (e.name.length > 100) {
      const long = bytes(`${e.name}\0`)
      parts.push(tarHeader('././@LongLink', long.length, 'L'), padTo512(long))
    }
    parts.push(tarHeader(e.name, data.length), padTo512(data))
  }
  parts.push(new Uint8Array(1024))
  return Buffer.concat(parts)
}

export const tgz = (entries: Entry[]): Uint8Array => gzipSync(tar(entries))

/** A zip of the entries (deflated), followed by `trailing` bytes, as a decrypted backup is. */
export function zip(entries: Entry[], trailing = 0): Uint8Array {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.from(bytes(e.data))
    const packed = deflateRawSync(raw)
    const name = Buffer.from(e.name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(packed.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(packed.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    local.push(lh, name, packed)
    central.push(ch, name)
    offset += lh.length + name.length + packed.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, dir, end, Buffer.alloc(trailing, 7)])
}

/** A UniFi Network backup: the zip, padded to whole blocks, encrypted as the application does. */
export function unf(entries: Entry[]): Uint8Array {
  const z = zip(entries, 5)
  const padded = Buffer.concat([z, Buffer.alloc((16 - (z.length % 16)) % 16)])
  const c = createCipheriv('aes-128-cbc', 'bcyangkmluohmars', 'ubntenterpriseap')
  c.setAutoPadding(false)
  return Buffer.concat([c.update(padded), c.final()])
}

/** A device as the console lists it, with the things the import mustn't keep. */
export const consoleDevice = (model: string, over: Record<string, unknown> = {}) => ({
  _id: 'abc123',
  mac: '02:00:00:00:00:01',
  serial: 'SECRET-SERIAL',
  name: 'Somebody’s access point',
  ip: '10.9.8.7',
  adopted: true,
  model,
  type: 'uap',
  shortname: '',
  sysid: 0,
  ...over,
})

/** A support file's devices.json: a list of sites, each of devices. */
export const devicesJson = (devices: unknown[]): string => JSON.stringify([{ super: [] }, { default: devices }])

/** A backup's configuration dump with a device table (and another table, whose rows must be left alone). */
export function configDump(devices: { model: string; type: string; adopted: boolean }[]): string {
  const cols = ['id', 'mac', 'model', 'type', 'name', 'adopted', 'serial']
  const lines = [
    JSON.stringify({ _t: 'table', schema: 'config', table: 'admin', columns: ['id', 'email', 'shadow'] }),
    JSON.stringify({ _t: 'row', v: ['1', 'me@example.com', '$6$hash'] }),
    JSON.stringify({ _t: 'table', schema: 'config', table: 'device', columns: cols }),
    ...devices.map((d, i) => JSON.stringify({ _t: 'row', v: [`id${i}`, `02:00:00:00:00:0${i}`, d.model, d.type, 'a name', d.adopted, 'SECRET-SERIAL'] })),
    JSON.stringify({ _t: 'table', schema: 'config', table: 'device_supervisor_link', columns: ['model'] }),
    JSON.stringify({ _t: 'row', v: ['NOT-A-DEVICE'] }),
  ]
  return lines.join('\n') + '\n'
}

export const gz = (text: string): Uint8Array => gzipSync(enc.encode(text))
