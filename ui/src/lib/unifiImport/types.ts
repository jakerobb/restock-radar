/** One device found in a UniFi file: the few facts the import uses, and nothing else (no MAC, serial, address or name). */
export interface FoundDevice {
  /** The model code the console reports: "UAPA6A4", "USMINI". */
  model: string
  /** The console's short name for it ("U7PROXGS"), when the file has one (a support file does, a backup doesn't). */
  shortname: string
  /** The device's system id as four hex digits, lower case, when the file has one. */
  sysid: string
  /** The console's kind of device: "uap", "usw", "udm". */
  type: string
}

/** Something wrong with the file, said so that it can be shown as it is. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}
