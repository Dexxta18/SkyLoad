import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setupEnv, sha1File, sleep } from './helpers.js'

const base = setupEnv()

// Imported after env is set, because config is read at import time.
const { default: WebTorrent } = await import('webtorrent')
const { Server: TrackerServer } = await import('bittorrent-tracker')
const { initDb, closeDb } = await import('../src/server/db/index.js')
const { buildApp } = await import('../src/server/app.js')
const { startWorker, stopWorker } = await import('../src/server/worker/index.js')

type App = Awaited<ReturnType<typeof buildApp>>

let app: App
let cookie = ''
let accountId = ''
let magnet = ''
const tracker = new TrackerServer({ udp: false, http: true, ws: false })
const seeder = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false })
const seedDir = path.join(base, 'seed')

async function api<T = any>(method: string, url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: { cookie } })
  const setCookie = res.headers['set-cookie']
  if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).map((c) => c.split(';')[0]).join('; ')
  return { status: res.statusCode, json: res.json() as T }
}

async function waitForStatus(jobId: string, statuses: string[], timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    const { json } = await api('GET', `/api/jobs/${jobId}`)
    if (statuses.includes(json.job.status)) return json.job
    if (json.job.status === 'failed' && !statuses.includes('failed')) assert.fail(`job failed: ${json.job.error}`)
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${statuses.join('/')}; last status ${json.job.status} ${json.job.note ?? ''}`)
    await sleep(250)
  }
}

const cloudDir = () => path.join(process.env.LOCAL_PROVIDER_DIR!, accountId)

// Seeded from memory: WebTorrent can't seed files from disk whose names contain
// characters it strips (like "?"), and we want to test exactly those names.
const content: Record<string, Buffer> = {
  'Album/video.bin': crypto.randomBytes(5 * 1024 * 1024 + 123),
  'Album/sub/notes.txt': Buffer.from('hello from a nested folder\n'),
  'Album/What?.txt': Buffer.from('odd name\n'),
}
const sha1 = (buf: Buffer) => crypto.createHash('sha1').update(buf).digest('hex')

before(async () => {
  fs.mkdirSync(seedDir, { recursive: true })
  const inputs = Object.entries(content).map(([name, data]) => Object.assign(Buffer.from(data), { name }))
  await new Promise<void>((resolve) => tracker.listen(0, '127.0.0.1', resolve))
  const announce = `http://127.0.0.1:${(tracker.http.address() as { port: number }).port}/announce`
  magnet = await new Promise<string>((resolve) =>
    seeder.seed(inputs, { announce: [announce], name: 'Album', path: seedDir }, (t) => resolve((t as unknown as { magnetURI: string }).magnetURI)),
  )

  await initDb()
  app = await buildApp()
  await startWorker()

  assert.equal((await api('POST', '/api/auth/dev-login', { email: 'tester@example.com' })).status, 200)
  const { json } = await api('POST', '/api/accounts/local')
  accountId = json.account.id
})

after(async () => {
  await stopWorker()
  await app.close()
  await closeDb()
  await new Promise<void>((r) => seeder.destroy(() => r()))
  await new Promise<void>((r) => tracker.close(() => r()))
})

describe('torrent to cloud', () => {
  test('downloads a magnet and uploads every file, keeping folders', async () => {
    const { status, json } = await api('POST', '/api/jobs/torrent', { magnet, destination: { accountId, folderId: 'root', folderName: 'Local' } })
    assert.equal(status, 200, JSON.stringify(json))
    const job = await waitForStatus(json.job.id, ['completed'])
    assert.equal(job.fileCount, 3)
    assert.equal(job.uploadedBytes, job.totalBytes)

    assert.equal(sha1File(path.join(cloudDir(), 'Album', 'video.bin')), sha1(content['Album/video.bin']))
    assert.equal(fs.readFileSync(path.join(cloudDir(), 'Album', 'sub', 'notes.txt'), 'utf8'), 'hello from a nested folder\n')
    assert.equal(fs.readFileSync(path.join(cloudDir(), 'Album', 'What?.txt'), 'utf8'), 'odd name\n')
    // The local download folder is removed right after the job completes.
    const downloadDir = path.join(process.env.DATA_DIR!, 'downloads', json.job.id)
    for (let i = 0; i < 20 && fs.existsSync(downloadDir); i++) await sleep(100)
    assert.equal(fs.existsSync(downloadDir), false)
  })

  test('lets the user choose files before downloading', async () => {
    fs.rmSync(path.join(cloudDir(), 'Album'), { recursive: true, force: true })
    const { json } = await api('POST', '/api/jobs/torrent', { magnet, chooseFiles: true, destination: { accountId, folderId: 'root', folderName: 'Local' } })
    const waiting = await waitForStatus(json.job.id, ['awaiting_selection'])
    const files = waiting.files as { index: number; path: string }[]
    const notes = files.find((f) => f.path.endsWith('notes.txt'))!
    const sel = await api('POST', `/api/jobs/${json.job.id}/select`, { fileIndexes: [notes.index] })
    assert.equal(sel.status, 200, JSON.stringify(sel.json))
    await waitForStatus(json.job.id, ['completed'])
    assert.ok(fs.existsSync(path.join(cloudDir(), 'Album', 'sub', 'notes.txt')))
    assert.equal(fs.existsSync(path.join(cloudDir(), 'Album', 'video.bin')), false)
  })

  test('rejects the same torrent twice while it is still running', async () => {
    const first = await api('POST', '/api/jobs/torrent', { magnet, chooseFiles: true, destination: { accountId, folderId: 'root', folderName: 'Local' } })
    const second = await api('POST', '/api/jobs/torrent', { magnet, destination: { accountId, folderId: 'root', folderName: 'Local' } })
    assert.equal(second.status, 409)
    await api('POST', `/api/jobs/${first.json.job.id}/cancel`)
  })

  test('accepts a .torrent file upload', async () => {
    fs.rmSync(path.join(cloudDir(), 'Album'), { recursive: true, force: true })
    const torrent = seeder.torrents[0]
    const boundary = '----skyload'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="destination"\r\n\r\n${JSON.stringify({ accountId, folderId: 'root', folderName: 'Local' })}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="torrent"; filename="album.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`),
      Buffer.from(torrent.torrentFile),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await app.inject({ method: 'POST', url: '/api/jobs/torrent', payload, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } })
    assert.equal(res.statusCode, 200, res.body)
    const job = res.json().job
    assert.equal(job.fileCount, 3)
    await waitForStatus(job.id, ['completed'])
    assert.equal(sha1File(path.join(cloudDir(), 'Album', 'video.bin')), sha1(content['Album/video.bin']))
  })

  test('handles empty files', async () => {
    // Seeded from disk: WebTorrent can't seed zero-length in-memory buffers.
    const packDir = path.join(base, 'pack', 'Pack')
    fs.mkdirSync(packDir, { recursive: true })
    fs.writeFileSync(path.join(packDir, 'empty.txt'), '')
    fs.writeFileSync(path.join(packDir, 'readme.txt'), 'not empty\n')
    const announce = `http://127.0.0.1:${(tracker.http.address() as { port: number }).port}/announce`
    const packMagnet = await new Promise<string>((resolve) => seeder.seed(packDir, { announce: [announce] }, (t) => resolve((t as unknown as { magnetURI: string }).magnetURI)))
    const { json } = await api('POST', '/api/jobs/torrent', { magnet: packMagnet, destination: { accountId, folderId: 'root', folderName: 'Local' } })
    await waitForStatus(json.job.id, ['completed'])
    assert.equal(fs.statSync(path.join(cloudDir(), 'Pack', 'empty.txt')).size, 0)
    assert.equal(fs.readFileSync(path.join(cloudDir(), 'Pack', 'readme.txt'), 'utf8'), 'not empty\n')
  })

  test('cancels a torrent that is still looking for peers', async () => {
    const lonely = `magnet:?xt=urn:btih:${crypto.randomBytes(20).toString('hex')}&dn=nobody-seeds-this`
    const { json } = await api('POST', '/api/jobs/torrent', { magnet: lonely, destination: { accountId, folderId: 'root', folderName: 'Local' } })
    await waitForStatus(json.job.id, ['metadata'])
    await api('POST', `/api/jobs/${json.job.id}/cancel`)
    await waitForStatus(json.job.id, ['cancelled'], 10_000)
  })

  test('rejects things that are not magnet links', async () => {
    for (const bad of ['http://127.0.0.1/evil.torrent', '/etc/passwd', 'magnet:?xt=urn:sha1:abc']) {
      const res = await api('POST', '/api/jobs/torrent', { magnet: bad, destination: { accountId, folderId: 'root', folderName: 'Local' } })
      assert.equal(res.status, 400, bad)
    }
  })
})

describe('cloud to cloud transfer', () => {
  test('copies a folder tree to another folder', async () => {
    const target = await api('POST', `/api/accounts/${accountId}/folders`, { parentId: 'root', name: 'Backup' })
    assert.equal(target.status, 200, JSON.stringify(target.json))
    const listing = await api('GET', `/api/accounts/${accountId}/files?folderId=root`)
    const album = listing.json.entries.find((e: { name: string }) => e.name === 'Album')
    assert.ok(album)

    const { json } = await api('POST', '/api/jobs/transfer', {
      sourceAccountId: accountId,
      items: [album],
      destination: { accountId, folderId: target.json.folder.id, folderName: 'Backup' },
      mode: 'copy',
    })
    await waitForStatus(json.job.id, ['completed'])
    assert.equal(sha1File(path.join(cloudDir(), 'Backup', 'Album', 'video.bin')), sha1(content['Album/video.bin']))
    assert.ok(fs.existsSync(path.join(cloudDir(), 'Backup', 'Album', 'sub', 'notes.txt')))
  })

  test('move removes the originals afterwards', async () => {
    const target = await api('POST', `/api/accounts/${accountId}/folders`, { parentId: 'root', name: 'Moved' })
    const { json } = await api('POST', '/api/jobs/transfer', {
      sourceAccountId: accountId,
      items: [{ id: 'Backup/Album/sub/notes.txt', name: 'notes.txt', isFolder: false, size: 27 }],
      destination: { accountId, folderId: target.json.folder.id, folderName: 'Moved' },
      mode: 'move',
    })
    await waitForStatus(json.job.id, ['completed'])
    assert.ok(fs.existsSync(path.join(cloudDir(), 'Moved', 'notes.txt')))
    assert.equal(fs.existsSync(path.join(cloudDir(), 'Backup', 'Album', 'sub', 'notes.txt')), false)
  })
})

describe('access control', () => {
  test("users can't see or use each other's jobs and accounts", async () => {
    const mine = cookie
    const jobs = (await api('GET', '/api/jobs')).json.jobs
    assert.ok(jobs.length > 0)
    cookie = ''
    await api('POST', '/api/auth/dev-login', { email: 'someone-else@example.com' })
    assert.equal((await api('GET', `/api/jobs/${jobs[0].id}`)).status, 404)
    assert.equal((await api('GET', `/api/accounts/${accountId}/files`)).status, 404)
    const res = await api('POST', '/api/jobs/torrent', { magnet, destination: { accountId, folderId: 'root', folderName: 'x' } })
    assert.equal(res.status, 404)
    cookie = mine
  })

  test('anonymous requests are rejected', async () => {
    const saved = cookie
    cookie = ''
    assert.equal((await api('GET', '/api/jobs')).status, 401)
    cookie = saved
  })
})
