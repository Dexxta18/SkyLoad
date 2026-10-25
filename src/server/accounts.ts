import { and, eq } from 'drizzle-orm'
import { db } from './db/index.js'
import { accounts, users, type Account, type ProviderId, type User } from './db/schema.js'
import { decrypt, encrypt } from './lib/crypto.js'
import { HttpError, UserError } from './lib/http.js'
import { log } from './lib/log.js'
import { getProvider } from './providers/index.js'
import type { AccountContext, AccountProfile, CloudClient, OAuthTokens } from './providers/types.js'

interface OAuthCredentials {
  refreshToken: string
}

const refreshing = new Map<string, Promise<string>>()

async function refreshAccessToken(account: Account): Promise<string> {
  const provider = getProvider(account.provider)
  if (!provider.oauth) throw new Error(`${provider.label} does not use OAuth`)
  const { refreshToken } = decrypt<OAuthCredentials>(account.credentials)
  let tokens: OAuthTokens
  try {
    tokens = await provider.oauth.refresh(refreshToken)
  } catch (err) {
    if (err instanceof HttpError && (err.status === 400 || err.status === 401)) {
      await db().update(accounts).set({ needsReauth: true }).where(eq(accounts.id, account.id))
      throw new UserError(`Access to ${provider.label} (${account.email ?? account.displayName}) has expired or was revoked. Reconnect it on the Accounts page.`, 401)
    }
    throw err
  }
  const update: Partial<Account> = {
    accessToken: encrypt(tokens.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + (tokens.expiresIn ?? 3600) * 1000),
    needsReauth: false,
  }
  // Some providers (Microsoft) rotate the refresh token on every use.
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) update.credentials = encrypt({ refreshToken: tokens.refreshToken })
  await db().update(accounts).set(update).where(eq(accounts.id, account.id))
  Object.assign(account, update)
  return tokens.accessToken
}

export function contextFor(account: Account): AccountContext {
  return {
    account,
    async token(force = false) {
      const fresh = account.accessToken && account.accessTokenExpiresAt && account.accessTokenExpiresAt.getTime() > Date.now() + 120_000
      if (fresh && !force) return decrypt<string>(account.accessToken!)
      // Several uploads may hit an expired token at once; refresh only once.
      let pending = refreshing.get(account.id)
      if (!pending) {
        pending = refreshAccessToken(account).finally(() => refreshing.delete(account.id))
        refreshing.set(account.id, pending)
      }
      return pending
    },
    credentials<T>() {
      return decrypt<T>(account.credentials)
    },
    async saveCredentials(value) {
      account.credentials = encrypt(value)
      await db().update(accounts).set({ credentials: account.credentials }).where(eq(accounts.id, account.id))
    },
  }
}

export function clientFor(account: Account): CloudClient {
  return getProvider(account.provider).client(contextFor(account))
}

/** Loads an account and checks it belongs to the user. */
export async function getAccount(userId: string, accountId: string): Promise<Account> {
  const [account] = await db()
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
  if (!account) throw new UserError('That storage account is not connected', 404)
  return account
}

export async function saveAccount(opts: {
  userId: string
  provider: ProviderId
  profile: AccountProfile
  credentials: unknown
  tokens?: OAuthTokens
}): Promise<Account> {
  const values = {
    userId: opts.userId,
    provider: opts.provider,
    externalId: opts.profile.externalId,
    email: opts.profile.email ?? null,
    displayName: opts.profile.displayName ?? null,
    credentials: encrypt(opts.credentials),
    accessToken: opts.tokens ? encrypt(opts.tokens.accessToken) : null,
    accessTokenExpiresAt: opts.tokens ? new Date(Date.now() + (opts.tokens.expiresIn ?? 3600) * 1000) : null,
    scope: opts.tokens?.scope ?? null,
    needsReauth: false,
  }
  const [account] = await db()
    .insert(accounts)
    .values(values)
    .onConflictDoUpdate({ target: [accounts.userId, accounts.provider, accounts.externalId], set: values })
    .returning()
  log.info({ userId: opts.userId, provider: opts.provider, accountId: account.id }, 'cloud account connected')
  return account
}

/** Safe-to-send view of an account (no credentials). */
export function publicAccount(a: Account) {
  return {
    id: a.id,
    provider: a.provider,
    email: a.email,
    displayName: a.displayName,
    needsReauth: a.needsReauth,
    limitedScope: a.provider === 'gdrive' && !!a.scope && !a.scope.split(' ').includes('https://www.googleapis.com/auth/drive'),
    createdAt: a.createdAt,
  }
}

/** The first account someone connects becomes where their downloads go. */
export async function setDefaultDestinationIfMissing(user: User, accountId: string, folderName: string) {
  if (user.settings.defaultDestination) return
  await db()
    .update(users)
    .set({ settings: { ...user.settings, defaultDestination: { accountId, folderId: 'root', folderName } } })
    .where(eq(users.id, user.id))
}
