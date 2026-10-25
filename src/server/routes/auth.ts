import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { saveAccount, setDefaultDestinationIfMissing } from '../accounts.js'
import { currentUser, endSession, loadUser, requireUser, secureCookies, startSession, upsertGoogleUser } from '../auth.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { accounts, users, type ProviderId } from '../db/schema.js'
import { encrypt, pkceChallenge, randomToken } from '../lib/crypto.js'
import { UserError } from '../lib/http.js'
import { log } from '../lib/log.js'
import { getProvider } from '../providers/index.js'
import { DRIVE_SCOPE } from '../providers/gdrive.js'

const OAUTH_COOKIE = 'sl_oauth'

interface OAuthState {
  state: string
  verifier: string
  provider: ProviderId
  purpose: 'login' | 'connect'
  userId?: string
  returnTo?: string
  forcedConsent?: boolean
}

const redirectUri = (provider: string) => `${config.appUrl}/api/auth/callback/${provider}`

/** Only allow redirects back into this app. */
function safeReturnTo(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : undefined
}

function beginOAuth(reply: FastifyReply, state: Omit<OAuthState, 'state' | 'verifier'>, loginHint?: string) {
  const provider = getProvider(state.provider)
  if (!provider.oauth) throw new UserError(`${provider.label} does not use OAuth`)
  const full: OAuthState = { ...state, state: randomToken(16), verifier: randomToken(48) }
  reply.setCookie(OAUTH_COOKIE, JSON.stringify(full), { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 600, signed: true })
  const url = provider.oauth.authorizeUrl({
    state: full.state,
    codeChallenge: pkceChallenge(full.verifier),
    redirectUri: redirectUri(state.provider),
    purpose: state.purpose,
    loginHint,
    forceConsent: state.forcedConsent,
  })
  return reply.redirect(url)
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/login', async (request, reply) => {
    const { returnTo } = request.query as { returnTo?: string }
    if (!getProvider('gdrive').enabled()) throw new UserError('Google sign-in is not configured on this server', 503)
    return beginOAuth(reply, { provider: 'gdrive', purpose: 'login', returnTo: safeReturnTo(returnTo) })
  })

  app.get('/api/auth/connect/:provider', { preHandler: requireUser }, async (request, reply) => {
    const { provider } = request.params as { provider: ProviderId }
    return beginOAuth(reply, { provider, purpose: 'connect', userId: currentUser(request).id, returnTo: '/accounts' })
  })

  app.get('/api/auth/callback/:provider', async (request, reply) => {
    const { provider: providerId } = request.params as { provider: ProviderId }
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string }
    const raw = request.cookies[OAUTH_COOKIE]
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/auth' })
    const unsigned = raw ? request.unsignCookie(raw) : undefined
    const saved: OAuthState | undefined = unsigned?.valid && unsigned.value ? JSON.parse(unsigned.value) : undefined
    const fail = (message: string) => reply.redirect(`${saved?.purpose === 'connect' ? '/accounts' : '/'}?error=${encodeURIComponent(message)}`)

    if (!saved || saved.state !== query.state || saved.provider !== providerId) return fail('Sign-in expired or was tampered with. Please try again.')
    if (query.error) return fail(query.error === 'access_denied' ? 'Access was not granted.' : (query.error_description ?? query.error))
    if (!query.code) return fail('Missing authorization code.')

    const provider = getProvider(providerId)
    try {
      const tokens = await provider.oauth!.exchange(query.code, saved.verifier, redirectUri(providerId))
      const profile = await provider.oauth!.profile(tokens.accessToken)

      if (saved.purpose === 'login') {
        if (!profile.email) return fail('Your Google account has no email address.')
        const user = await upsertGoogleUser({ sub: profile.externalId, email: profile.email, name: profile.displayName, avatarUrl: profile.avatarUrl })
        await startSession(reply, user.id)

        const grantedDrive = (tokens.scope ?? '').split(' ').includes(DRIVE_SCOPE)
        if (grantedDrive) {
          const [existing] = await db()
            .select()
            .from(accounts)
            .where(and(eq(accounts.userId, user.id), eq(accounts.provider, 'gdrive'), eq(accounts.externalId, profile.externalId)))
          if (tokens.refreshToken) {
            const account = await saveAccount({ userId: user.id, provider: 'gdrive', profile, credentials: { refreshToken: tokens.refreshToken }, tokens })
            await setDefaultDestinationIfMissing(user, account.id, 'My Drive')
          } else if (existing) {
            await db()
              .update(accounts)
              .set({ accessToken: encrypt(tokens.accessToken), accessTokenExpiresAt: new Date(Date.now() + (tokens.expiresIn ?? 3600) * 1000), scope: tokens.scope ?? existing.scope })
              .where(eq(accounts.id, existing.id))
          } else if (!saved.forcedConsent) {
            // Google skips the refresh token when consent was given before; ask once more.
            return beginOAuth(reply, { ...saved, forcedConsent: true }, profile.email)
          }
        }
        return reply.redirect(saved.returnTo ?? '/')
      }

      const user = await loadUser(request)
      if (!user || user.id !== saved.userId) return fail('Please sign in again before connecting an account.')
      if (!tokens.refreshToken) return fail(`${provider.label} did not grant offline access. Please try again.`)
      const account = await saveAccount({ userId: user.id, provider: providerId, profile, credentials: { refreshToken: tokens.refreshToken }, tokens })
      await setDefaultDestinationIfMissing(user, account.id, provider.label)
      return reply.redirect(`/accounts?connected=${providerId}`)
    } catch (err) {
      log.error({ err, provider: providerId }, 'OAuth callback failed')
      return fail(err instanceof UserError ? err.message : `Could not connect ${provider.label}. Please try again.`)
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    await endSession(request, reply)
    return { ok: true }
  })

  if (config.devLogin) {
    app.post('/api/auth/dev-login', async (request, reply) => {
      const { email } = z.object({ email: z.string().email() }).parse(request.body)
      const [existing] = await db().select().from(users).where(eq(users.email, email.toLowerCase()))
      const user = existing ?? (await db().insert(users).values({ email: email.toLowerCase(), name: email.split('@')[0] }).returning())[0]
      await startSession(reply, user.id)
      return { ok: true }
    })
  }

  app.get('/api/me', async (request: FastifyRequest) => {
    const user = await loadUser(request)
    if (!user) return { user: null }
    return { user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, settings: user.settings } }
  })

  app.patch('/api/me/settings', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request)
    const body = z
      .object({ defaultDestination: z.object({ accountId: z.string().uuid(), folderId: z.string().min(1), folderName: z.string().max(500) }).optional() })
      .parse(request.body)
    const settings = { ...user.settings, ...body }
    await db().update(users).set({ settings }).where(eq(users.id, user.id))
    return { settings }
  })
}
