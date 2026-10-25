import type { Readable } from 'node:stream'

/**
 * Re-slices a byte stream into chunks of exactly `size` bytes (the last one may
 * be shorter). Cloud upload APIs need fixed, aligned chunk sizes.
 */
export async function* fixedChunks(stream: Readable | AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Buffer> {
  let parts: Buffer[] = []
  let buffered = 0
  for await (const piece of stream as AsyncIterable<Uint8Array>) {
    let buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece)
    while (buf.length > 0) {
      const take = Math.min(size - buffered, buf.length)
      parts.push(buf.subarray(0, take))
      buffered += take
      buf = buf.subarray(take)
      if (buffered === size) {
        yield parts.length === 1 ? parts[0] : Buffer.concat(parts, size)
        parts = []
        buffered = 0
      }
    }
  }
  if (buffered > 0) yield Buffer.concat(parts, buffered)
}

/**
 * Like fixedChunks, but tells you whether each chunk is the last one by reading
 * one chunk ahead. Needed by APIs that want the final chunk flagged.
 */
export async function* chunksWithLast(stream: Readable | AsyncIterable<Uint8Array>, size: number): AsyncGenerator<{ chunk: Buffer; last: boolean }> {
  let previous: Buffer | undefined
  for await (const chunk of fixedChunks(stream, size)) {
    if (previous) yield { chunk: previous, last: false }
    previous = chunk
  }
  yield { chunk: previous ?? Buffer.alloc(0), last: true }
}
