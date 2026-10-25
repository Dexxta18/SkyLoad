import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { setupEnv } from './helpers.js'

setupEnv()
const { driveClient, GDRIVE_CHUNK_SIZE } = await import('../src/server/providers/gdrive.js')

interface Session {
  received: Buffer[]
  bytes: number
  total: number | null
}

/** A tiny imitation of Drive's resumable upload protocol, with optional faults. */
async function mockDrive(opts: { dropMidChunk?: number; rejectFirstToken?: boolean }) {
  const sessions = new Map<string, Session>()
  const stats = { statusQueries: 0, puts: 0, tokensSeen: new Set<string>() }
  let dataPuts = 0
  let rejectedToken = false
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const auth = req.headers.authorization ?? ''
    stats.tokensSeen.add(auth)
    if (opts.rejectFirstToken && !rejectedToken) {
      rejectedToken = true
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'expired' } }))
      return
    }
    const url = new URL(req.url!, 'http://x')
    if (req.method === 'POST' && url.pathname === '/upload/files') {
      const meta = JSON.parse(body.toString())
      const id = crypto.randomUUID()
      const declared = req.headers['x-upload-content-length']
      sessions.set(id, { received: [], bytes: 0, total: declared ? Number(declared) : null })
      res.writeHead(200, { location: `http://127.0.0.1:${(server.address() as { port: number }).port}/session/${id}?name=${encodeURIComponent(meta.name)}` }).end()
      return
    }
    const match = url.pathname.match(/^\/session\/(.+)$/)
    if (req.method === 'PUT' && match) {
      const session = sessions.get(match[1])!
      const range = String(req.headers['content-range'])
      const status = range.match(/^bytes \*\/(\d+|\*)$/)
      const data = range.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/)
      const done = () =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'file-1', name: url.searchParams.get('name'), mimeType: 'application/octet-stream', size: String(session.bytes) }))
      const incomplete = () => {
        const headers: Record<string, string> = {}
        if (session.bytes > 0) headers.range = `bytes=0-${session.bytes - 1}`
        res.writeHead(308, headers).end()
      }
      if (status) {
        stats.statusQueries++
        if (status[1] !== '*') session.total = Number(status[1])
        return session.total !== null && session.bytes === session.total ? done() : incomplete()
      }
      if (data) {
        stats.puts++
        const start = Number(data[1])
        assert.equal(start, session.bytes, 'client resent from the wrong offset')
        if (data[3] !== '*') session.total = Number(data[3])
        dataPuts++
        if (opts.dropMidChunk === dataPuts) {
          // Keep half the chunk, then drop the connection like a flaky network would.
          const half = body.subarray(0, Math.floor(body.length / 2))
          session.received.push(half)
          session.bytes += half.length
          req.socket.destroy()
          return
        }
        session.received.push(body)
        session.bytes += body.length
        return session.total !== null && session.bytes === session.total ? done() : incomplete()
      }
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, sessions, stats, base: `http://127.0.0.1:${port}` }
}

function fakeContext() {
  let n = 0
  return {
    account: { id: 'acc', provider: 'gdrive' } as never,
    refreshes: () => n,
    async token(force?: boolean) {
      if (force) n++
      return `token-${n}`
    },
    credentials: <T>() => ({}) as T,
    async saveCredentials() {},
  }
}

test('uploads in aligned chunks and reports progress', async () => {
  const mock = await mockDrive({})
  const data = crypto.randomBytes(GDRIVE_CHUNK_SIZE * 2 + 12345)
  const progress: number[] = []
  const client = driveClient(fakeContext(), mock.base, `${mock.base}/upload`)
  const entry = await client.upload({ parentId: 'root', name: 'big.bin', size: data.length, stream: Readable.from([data]), onProgress: (b) => progress.push(b) })
  const [session] = mock.sessions.values()
  assert.equal(entry.name, 'big.bin')
  assert.ok(Buffer.concat(session.received).equals(data))
  assert.equal(mock.stats.puts, 3)
  assert.deepEqual(progress, [GDRIVE_CHUNK_SIZE, GDRIVE_CHUNK_SIZE * 2, data.length])
  mock.server.close()
})

test('resumes from the server offset when a connection drops mid-chunk', async () => {
  const mock = await mockDrive({ dropMidChunk: 2 })
  const data = crypto.randomBytes(GDRIVE_CHUNK_SIZE * 2 + 999)
  const client = driveClient(fakeContext(), mock.base, `${mock.base}/upload`)
  // Feed it in odd-sized pieces like a real file stream.
  const pieces = []
  for (let i = 0; i < data.length; i += 1_000_003) pieces.push(data.subarray(i, i + 1_000_003))
  await client.upload({ parentId: 'root', name: 'flaky.bin', size: data.length, stream: Readable.from(pieces) })
  const [session] = mock.sessions.values()
  assert.ok(Buffer.concat(session.received).equals(data), 'uploaded bytes differ from source')
  assert.ok(mock.stats.statusQueries >= 1, 'client should ask the server how much it has')
  mock.server.close()
})

test('handles uploads whose size is not known up front', async () => {
  const mock = await mockDrive({})
  const data = crypto.randomBytes(GDRIVE_CHUNK_SIZE + 5)
  const client = driveClient(fakeContext(), mock.base, `${mock.base}/upload`)
  await client.upload({ parentId: 'root', name: 'export.docx', size: null, stream: Readable.from([data]) })
  const [session] = mock.sessions.values()
  assert.ok(Buffer.concat(session.received).equals(data))
  mock.server.close()
})

test('uploads empty files', async () => {
  const mock = await mockDrive({})
  const client = driveClient(fakeContext(), mock.base, `${mock.base}/upload`)
  const entry = await client.upload({ parentId: 'root', name: 'empty.txt', size: 0, stream: Readable.from([]) })
  assert.equal(entry.size, 0)
  mock.server.close()
})

test('refreshes the access token once on 401', async () => {
  const mock = await mockDrive({ rejectFirstToken: true })
  const ctx = fakeContext()
  const client = driveClient(ctx, mock.base, `${mock.base}/upload`)
  await client.upload({ parentId: 'root', name: 'a.txt', size: 3, stream: Readable.from([Buffer.from('abc')]) })
  assert.equal(ctx.refreshes(), 1)
  assert.ok(mock.stats.tokensSeen.has('Bearer token-1'))
  mock.server.close()
})
