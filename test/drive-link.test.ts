import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { setupEnv, sleep } from './helpers.js'

setupEnv()
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'

// A tiny stand-in for the Drive API: two shared items, one private one.
const FOLDER = 'application/vnd.google-apps.folder'
const items: Record<string, { id: string; name: string; mimeType: string; size?: string }> = {
  sharedFile01: { id: 'sharedFile01', name: 'Movie.mp4', mimeType: 'video/mp4', size: '1234' },
  sharedFolder01: { id: 'sharedFolder01', name: 'Holiday', mimeType: FOLDER },
  inFolderA: { id: 'inFolderA', name: 'a.jpg', mimeType: 'image/jpeg', size: '10' },
  inFolderB: { id: 'inFolderB', name: 'b.jpg', mimeType: 'image/jpeg', size: '20' },
}
const copies: { id: string; parents: string[]; name: string }[] = []
const created: { name: string; parents: string[] }[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (url.hostname !== 'www.googleapis.com') return realFetch(input, init)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const path = url.pathname.replace('/drive/v3', '')
  const copy = path.match(/^\/files\/([^/]+)\/copy$/)
  if (copy && init?.method === 'POST') {
    const body = JSON.parse(String(init.body))
    copies.push({ id: copy[1], parents: body.parents, name: body.name })
    return json({ id: `copy-${copy[1]}`, name: body.name, mimeType: items[copy[1]].mimeType })
  }
  if (path === '/files' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body))
    created.push({ name: body.name, parents: body.parents })
    return json({ id: 'newFolder01', name: body.name, mimeType: FOLDER, webViewLink: 'https://drive.google.com/drive/folders/newFolder01' })
  }
  if (path === '/files') {
    const q = url.searchParams.get('q') ?? ''
    if (q.includes("'sharedFolder01' in parents")) return json({ files: [items.inFolderA, items.inFolderB] })
    return json({ files: [] })
  }
  const get = path.match(/^\/files\/([^/]+)$/)
  if (get) return items[get[1]] ? json(items[get[1]]) : json({ error: { message: 'File not found' } }, 404)
  return json({ error: { message: `unexpected ${path}` } }, 500)
}) as typeof fetch

const { initDb, closeDb } = await import('../src/server/db/index.js')
const { buildApp } = await import('../src/server/app.js')
const { saveAccount } = await import('../src/server/accounts.js')
const { startWorker, stopWorker } = await import('../src/server/worker/index.js')

let app: Awaited<ReturnType<typeof buildApp>>
let cookie = ''
let driveId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: { cookie } })
  const set = res.headers['set-cookie']
  if (set) cookie = ([] as string[]).concat(set).map((c) => c.split(';')[0]).join('; ')
  return { status: res.statusCode, json: res.json() }
}

async function waitFor(id: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const { json } = await api('GET', `/api/jobs/${id}`)
    if (json.job.status === status) return json.job
    if (json.job.status === 'failed') assert.fail(`job failed: ${json.job.error}`)
    await sleep(100)
  }
  assert.fail(`timed out waiting for ${status}`)
}

before(async () => {
  await initDb()
  app = await buildApp()
  await startWorker()
  await api('POST', '/api/auth/dev-login', { email: 'drive@example.com' })
  const me = (await api('GET', '/api/me')).json.user
  const account = await saveAccount({
    userId: me.id,
    provider: 'gdrive',
    profile: { externalId: 'g-1', email: 'drive@example.com' },
    credentials: { refreshToken: 'refresh' },
    tokens: { accessToken: 'access', expiresIn: 3600, scope: 'https://www.googleapis.com/auth/drive' },
  })
  driveId = account.id
})
after(async () => {
  await stopWorker()
  await app.close()
  await closeDb()
})

const start = (url: string) => api('POST', '/api/jobs/url', { url, destination: { accountId: driveId, folderId: 'root', folderName: 'My Drive' } })

test('a shared Drive file is copied inside Google, not downloaded', async () => {
  const { status, json } = await start('https://drive.google.com/file/d/sharedFile01/view?usp=sharing')
  assert.equal(status, 200, JSON.stringify(json))
  assert.equal(json.job.name, 'Movie.mp4')
  assert.equal(json.job.totalBytes, 1234)
  await waitFor(json.job.id, 'completed')
  assert.deepEqual(copies, [{ id: 'sharedFile01', parents: ['root'], name: 'Movie.mp4' }])
})

test('a shared Drive folder is copied with its contents', async () => {
  copies.length = 0
  const { json } = await start('https://drive.google.com/drive/folders/sharedFolder01?usp=drive_link')
  assert.equal(json.job.name, 'Holiday')
  const job = await waitFor(json.job.id, 'completed')
  assert.deepEqual(created, [{ name: 'Holiday', parents: ['root'] }])
  assert.deepEqual(
    copies.map((c) => [c.id, c.parents[0]]),
    [
      ['inFolderA', 'newFolder01'],
      ['inFolderB', 'newFolder01'],
    ],
  )
  assert.equal(job.result.url, 'https://drive.google.com/drive/folders/newFolder01')
})

test("a Drive file the account can't open falls back to the public download link", async () => {
  const { status, json } = await start('https://drive.google.com/file/d/privateFile01/view')
  assert.equal(status, 200)
  const detail = (await api('GET', `/api/jobs/${json.job.id}`)).json.job
  assert.equal(detail.input.url, 'https://drive.usercontent.google.com/download?id=privateFile01&export=download&confirm=t')
  await api('POST', `/api/jobs/${json.job.id}/cancel`)
})

test("a Drive folder the account can't open gives a clear error", async () => {
  const { status, json } = await start('https://drive.google.com/drive/folders/privateFolder01')
  assert.equal(status, 400)
  assert.match(json.error, /shared as "Anyone with the link"/)
})
