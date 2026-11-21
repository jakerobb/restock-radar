import { readNetworkBackup } from './networkBackup'
import { readSupportFile } from './supportFile'
import { ImportError, type FoundDevice } from './types'

export { ImportError, type FoundDevice } from './types'

/**
 * The devices in a file from a UniFi console: a support file (a gzipped tar) or a UniFi Network backup (.unf).
 * The file is read here, in the browser, and goes nowhere; of what is in it only the model of each device is
 * kept, so nothing else in it (passwords, keys, addresses, client lists) is ever held past the read.
 */
export async function readUnifiFile(file: Blob & { name?: string }): Promise<FoundDevice[]> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer())
  const devices = head[0] === 0x1f && head[1] === 0x8b ? await readSupportFile(file) : await readNetworkBackup(file, /\.unifi$/i.test(file.name ?? ''))
  if (devices.length === 0) throw new ImportError('No devices are adopted in that file.')
  return devices
}
