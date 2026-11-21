/** A stream that gives bytes already in memory, as one piece. */
export const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

/** A stream of bytes through a decompressor. */
export const decompressed = (data: ReadableStream<Uint8Array>, format: 'gzip' | 'deflate-raw'): ReadableStream<Uint8Array> =>
  data.pipeThrough(new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)

/** Everything a stream holds, up to `limit` bytes; null if it holds more (the stream is cancelled). */
export async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  return concat(parts, total)
}

export function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1 && parts[0]!.length === total) return parts[0]!
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Reads a stream of bytes a piece at a time, so that what isn't wanted can be skipped without being kept. */
export class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private buf: Uint8Array = new Uint8Array(0)

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }

  /** Up to n bytes (fewer only at the end of the stream). */
  async read(n: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    let got = 0
    while (got < n) {
      if (this.buf.length === 0 && !(await this.pull())) break
      const take = Math.min(n - got, this.buf.length)
      parts.push(this.buf.subarray(0, take))
      this.buf = this.buf.subarray(take)
      got += take
    }
    return concat(parts, got)
  }

  /** Drops n bytes; false if the stream ended first. */
  async skip(n: number): Promise<boolean> {
    while (n > 0) {
      if (this.buf.length === 0 && !(await this.pull())) return false
      const take = Math.min(n, this.buf.length)
      this.buf = this.buf.subarray(take)
      n -= take
    }
    return true
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined)
  }

  private async pull(): Promise<boolean> {
    const { done, value } = await this.reader.read()
    if (done) return false
    this.buf = value
    return true
  }
}
