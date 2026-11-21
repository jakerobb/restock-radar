import { randomBytes } from 'node:crypto'
import { readUnifiFile } from './index'
import { readNetworkBackup } from './networkBackup'
import { readSupportFile } from './supportFile'
import { ImportError } from './types'
import { blobOf, configDump, consoleDevice, devicesJson, gz, tgz, unf } from './testFiles'

const SITE = [
  consoleDevice('UAPA6A4', { shortname: 'U7PROXGS', sysid: 42660 }),
  consoleDevice('USWED35', { type: 'USW', shortname: 'USM25G5', sysid: 60725 }),
  consoleDevice('USMINI', { adopted: false }),
]

describe('readSupportFile', () => {
  it('finds the device list among everything else in the archive and keeps only the model facts', async () => {
    const file = tgz([
      { name: 'support-X/system/big.log', data: new Uint8Array(3000).fill(65) },
      { name: 'support-X/unifi/devices.json', data: devicesJson(SITE) },
      { name: 'support-X/system/after.log', data: 'never needed' },
    ])
    const devices = await readSupportFile(blobOf(file))
    expect(devices).toEqual([
      { model: 'UAPA6A4', shortname: 'U7PROXGS', sysid: 'a6a4', type: 'uap' },
      { model: 'USWED35', shortname: 'USM25G5', sysid: 'ed35', type: 'usw' },
    ])
    // Nothing else of the device came out with it.
    expect(JSON.stringify(devices)).not.toMatch(/SECRET|02:00|10\.9|Somebody/)
  })

  it('reads a device list whose path is in a long-name entry', async () => {
    const name = `support-${'x'.repeat(120)}/unifi/devices.json`
    expect(await readSupportFile(blobOf(tgz([{ name, data: devicesJson(SITE) }])))).toHaveLength(2)
  })

  it('stops once it has the list, so what follows needn’t be readable', async () => {
    // Several megabytes that don't compress, then cut short: reading it to the end would fail.
    const whole = tgz([{ name: 's/unifi/devices.json', data: devicesJson(SITE) }, { name: 's/other', data: randomBytes(6_000_000) }])
    expect(await readSupportFile(blobOf(whole.subarray(0, whole.length - 1_000_000)))).toHaveLength(2)
  })

  it('says so when the archive has no device list, or isn’t a support file at all', async () => {
    await expect(readSupportFile(blobOf(tgz([{ name: 's/system/x', data: 'x' }])))).rejects.toThrow(/no UniFi Network device list/)
    await expect(readSupportFile(blobOf(new Uint8Array([0x1f, 0x8b, 1, 2, 3])))).rejects.toBeInstanceOf(ImportError)
  })
})

describe('readNetworkBackup', () => {
  const backup = (devices: { model: string; type: string; adopted: boolean }[]) => unf([{ name: 'backup.json', data: '{}' }, { name: 'db-config.jsonl.gz', data: gz(configDump(devices)) }])

  it('decrypts the backup and reads the adopted devices of its device table, and no other table', async () => {
    const file = backup([
      { model: 'UAPA6A4', type: 'UAP', adopted: true },
      { model: 'USMINI', type: 'USW', adopted: true },
      { model: 'USWED35', type: 'USW', adopted: false },
    ])
    expect(await readNetworkBackup(blobOf(file))).toEqual([
      { model: 'UAPA6A4', shortname: '', sysid: '', type: 'uap' },
      { model: 'USMINI', shortname: '', sysid: '', type: 'usw' },
    ])
  })

  it('says so for a backup of an older version, which has a Mongo dump', async () => {
    await expect(readNetworkBackup(blobOf(unf([{ name: 'db.gz', data: 'x' }])))).rejects.toThrow(/older version/)
  })

  it('refuses what isn’t a Network backup, naming a UniFi OS backup for what it is', async () => {
    const noise = new Uint8Array(640).map((_, i) => (i * 31 + 7) & 255)
    await expect(readNetworkBackup(blobOf(noise))).rejects.toThrow(/isn't a UniFi Network backup/)
    await expect(readNetworkBackup(blobOf(noise), true)).rejects.toThrow(/UniFi OS backup/)
    await expect(readNetworkBackup(blobOf(new Uint8Array(30)))).rejects.toBeInstanceOf(ImportError)
  })
})

describe('readUnifiFile', () => {
  it('reads a support file or a backup, whichever it is given', async () => {
    expect(await readUnifiFile(blobOf(tgz([{ name: 's/unifi/devices.json', data: devicesJson(SITE) }])))).toHaveLength(2)
    expect(await readUnifiFile(blobOf(unf([{ name: 'db-config.jsonl.gz', data: gz(configDump([{ model: 'USMINI', type: 'USW', adopted: true }])) }])))).toHaveLength(1)
  })

  it('says so when a file has no devices in it', async () => {
    await expect(readUnifiFile(blobOf(tgz([{ name: 's/unifi/devices.json', data: devicesJson([]) }])))).rejects.toThrow(/No devices/)
  })

  it('names a .unifi file as a UniFi OS backup', async () => {
    await expect(readUnifiFile(blobOf(new Uint8Array(640).map((_, i) => (i * 13) & 255), 'unifi_os_backup_1.unifi'))).rejects.toThrow(/UniFi OS backup/)
  })
})
