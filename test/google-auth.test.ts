import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { setupEnv } from './helpers.js'

setupEnv()
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'

// Stand-in for Google's token, profile and Drive endpoints. Everything else
// goes to the real fetch.
const google = {
  refreshToken: 'refresh-1' as string | undefined,
  scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive',
  sub: 'google-user-1',
  email: 'Dami@Example.com',
  tokenCalls: [] as URLSearchParams[],
}
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (url === 'https://oauth2.googleapis.com/token') {
    const params = new URLSearchParams(String(init?.body))
    google.tokenCalls.push(params)
    if (params.get('grant_type') === 'refresh_token') return json({ access_token: 'access-refreshed', expires_in: 3600, scope: google.scope })
    return json({ access_token: 'access-1', refresh_token: google.refreshToken, expires_in: 3600, scope: google.scope })
  }
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ sub: google.sub, email: google.email, name: 'Dami', picture: 'https://example.com/a.png' })
  if (url.startsWith('https://www.googleapis.com/drive/v3/about')) {
    const auth = new Headers(init?.headers).get('authorization')
    return auth === 'Bearer access-refreshed' ? json({ storageQuota: { limit: '16106127360', usage: '1073741824' } }) : json({ error: { message: 'expired' } }, 401)
  }
  return realFetch(input, init)
}) as typeof fetch

const { initDb, closeDb, db } = await import('../src/server/db/index.js')
const { accounts } = await import('../src/server/db/schema.js')
const { buildApp } = await import('../src/server/app.js')
let app: Awaited<ReturnType<typeof buildApp>>

before(async () => {
  await initDb()
  app = await buildApp()
})
after(async () => {
  await app.close()
  await closeDb()
})

const cookiesFrom = (res: { headers: Record<string, unknown> }) =>
  ([] as string[])
    .concat((res.headers['set-cookie'] as string | string[] | undefined) ?? [])
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))

/** Starts sign-in and plays Google's redirect back to the app. */
async function signIn(cookie = '') {
  const start = await app.inject({ method: 'GET', url: '/api/auth/login', headers: { cookie } })
  assert.equal(start.statusCode, 302)
  const authorize = new URL(start.headers.location as string)
  assert.equal(authorize.origin, 'https://accounts.google.com')
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth/callback/gdrive')
  assert.match(authorize.searchParams.get('scope')!, /auth\/drive/)
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  const oauthCookie = cookiesFrom(start).join('; ')
  const callback = await app.inject({
    method: 'GET',
    url: `/api/auth/callback/gdrive?code=the-code&state=${authorize.searchParams.get('state')}`,
    headers: { cookie: [cookie, oauthCookie].filter(Boolean).join('; ') },
  })
  return { callback, authorize, session: cookiesFrom(callback).find((c) => c.startsWith('sl_session=')) }
}

test('first sign-in creates the user, connects Drive and sets it as the default destination', async () => {
  const { callback, session } = await signIn()
  assert.equal(callback.statusCode, 302)
  assert.equal(callback.headers.location, '/')
  assert.ok(session, 'session cookie set')

  const me = (await app.inject({ url: '/api/me', headers: { cookie: session! } })).json().user
  assert.equal(me.email, 'dami@example.com')
  const list = (await app.inject({ url: '/api/accounts', headers: { cookie: session! } })).json().accounts
  assert.equal(list.length, 1)
  assert.equal(list[0].provider, 'gdrive')
  assert.equal(me.settings.defaultDestination.accountId, list[0].id)
  assert.equal(me.settings.defaultDestination.folderName, 'My Drive')

  // PKCE verifier and code were sent to Google.
  const exchange = google.tokenCalls.find((p) => p.get('grant_type') === 'authorization_code')!
  assert.equal(exchange.get('code'), 'the-code')
  assert.ok(exchange.get('code_verifier'))

  // Stored credentials are encrypted, not plain tokens.
  const [row] = await db().select().from(accounts)
  assert.doesNotMatch(row.credentials, /refresh-1/)
})

test('signing in again without a new refresh token keeps the Drive connection', async () => {
  google.refreshToken = undefined
  const { callback } = await signIn()
  assert.equal(callback.headers.location, '/')
  const rows = await db().select().from(accounts)
  assert.equal(rows.length, 1)
})

test('a brand-new user without a refresh token is sent back for consent once', async () => {
  google.sub = 'google-user-2'
  google.email = 'second@example.com'
  google.refreshToken = undefined
  const { callback } = await signIn()
  assert.equal(callback.statusCode, 302)
  const again = new URL(callback.headers.location as string)
  assert.equal(again.origin, 'https://accounts.google.com')
  assert.match(again.searchParams.get('prompt')!, /consent/)
  assert.equal(again.searchParams.get('login_hint'), 'second@example.com')
  // The retry needs a fresh state cookie that matches the new authorize URL.
  const raw = ([] as string[]).concat(callback.headers['set-cookie'] as string[]).filter((c) => c.startsWith('sl_oauth='))
  const last = raw[raw.length - 1]
  assert.ok(last && !last.startsWith('sl_oauth=;'), 'fresh sl_oauth cookie is set last')
  assert.ok(decodeURIComponent(last).includes(again.searchParams.get('state')!))
})

test('a tampered or expired state is rejected', async () => {
  const start = await app.inject({ method: 'GET', url: '/api/auth/login' })
  const res = await app.inject({ method: 'GET', url: '/api/auth/callback/gdrive?code=x&state=wrong', headers: { cookie: cookiesFrom(start).join('; ') } })
  assert.equal(res.statusCode, 302)
  assert.match(res.headers.location as string, /^\/\?error=/)
})

test('an expired access token is refreshed transparently', async () => {
  google.sub = 'google-user-1'
  google.email = 'dami@example.com'
  google.refreshToken = 'refresh-1'
  const { session } = await signIn()
  const [account] = await db().select().from(accounts)
  // Force expiry.
  const { eq } = await import('drizzle-orm')
  await db().update(accounts).set({ accessTokenExpiresAt: new Date(0) }).where(eq(accounts.id, account.id))
  const res = await app.inject({ url: `/api/accounts/${account.id}/quota`, headers: { cookie: session! } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().quota, { used: 1073741824, total: 16106127360 })
  assert.ok(google.tokenCalls.some((p) => p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'refresh-1'))
})
