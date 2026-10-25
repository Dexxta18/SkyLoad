import type { FastifyInstance } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { clientFor, getAccount, publicAccount, saveAccount, setDefaultDestinationIfMissing } from '../accounts.js'
import { currentUser, requireUser } from '../auth.js'
import { db } from '../db/index.js'
import { accounts, users } from '../db/schema.js'
import { UserError } from '../lib/http.js'
import { forgetMegaSession, megaLogin } from '../providers/mega.js'
import { enabledProviders, getProvider } from '../providers/index.js'

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((n) => !/[\\/]/.test(n) && n !== '.' && n !== '..', 'Folder names cannot contain slashes')

export async function accountRoutes(app: FastifyInstance) {
  app.get('/api/providers', async () => ({ providers: enabledProviders() }))

  app.register(async (authed) => {
    authed.addHook('preHandler', requireUser)

    authed.get('/api/accounts', async (request) => {
      const user = currentUser(request)
      const rows = await db().select().from(accounts).where(eq(accounts.userId, user.id)).orderBy(desc(accounts.createdAt))
      return { accounts: rows.map(publicAccount) }
    })

    authed.get('/api/accounts/:id/quota', async (request) => {
      const { id } = request.params as { id: string }
      const account = await getAccount(currentUser(request).id, id)
      return { quota: await clientFor(account).quota() }
    })

    authed.get('/api/accounts/:id/files', async (request) => {
      const { id } = request.params as { id: string }
      const { folderId } = request.query as { folderId?: string }
      const account = await getAccount(currentUser(request).id, id)
      const client = clientFor(account)
      const folder = folderId || client.rootId
      return { folderId: folder, entries: await client.list(folder) }
    })

    authed.post('/api/accounts/:id/folders', async (request) => {
      const { id } = request.params as { id: string }
      const body = z.object({ parentId: z.string().min(1), name: nameSchema }).parse(request.body)
      const account = await getAccount(currentUser(request).id, id)
      return { folder: await clientFor(account).ensureFolder(body.parentId, body.name) }
    })

    authed.delete('/api/accounts/:id', async (request) => {
      const user = currentUser(request)
      const { id } = request.params as { id: string }
      await getAccount(user.id, id)
      await db()
        .delete(accounts)
        .where(and(eq(accounts.id, id), eq(accounts.userId, user.id)))
      forgetMegaSession(id)
      if (user.settings.defaultDestination?.accountId === id) {
        await db()
          .update(users)
          .set({ settings: { ...user.settings, defaultDestination: undefined } })
          .where(eq(users.id, user.id))
      }
      return { ok: true }
    })

    authed.post('/api/accounts/mega', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request) => {
      getProvider('mega')
      const user = currentUser(request)
      const body = z.object({ email: z.string().email(), password: z.string().min(1), code: z.string().regex(/^\d{6}$/).optional().or(z.literal('')) }).parse(request.body)
      const { credentials, profile } = await megaLogin(body.email, body.password, body.code || undefined)
      const account = await saveAccount({ userId: user.id, provider: 'mega', profile, credentials })
      forgetMegaSession(account.id)
      await setDefaultDestinationIfMissing(user, account.id, 'Mega')
      return { account: publicAccount(account) }
    })

    // Dev/test only: connect the local-folder provider without any credentials.
    authed.post('/api/accounts/local', async (request) => {
      const provider = getProvider('local')
      if (!provider.enabled()) throw new UserError('Not available', 404)
      const user = currentUser(request)
      const account = await saveAccount({ userId: user.id, provider: 'local', profile: { externalId: 'local', displayName: 'Local folder' }, credentials: {} })
      await setDefaultDestinationIfMissing(user, account.id, 'Local folder')
      return { account: publicAccount(account) }
    })
  })
}
