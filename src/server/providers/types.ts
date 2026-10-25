import type { Readable } from 'node:stream'
import type { Account, ProviderId } from '../db/schema.js'

/** A file or folder in a cloud account. `id` is opaque and provider specific. */
export interface Entry {
  id: string
  name: string
  isFolder: boolean
  size: number | null
  modifiedAt?: string
  mimeType?: string
  url?: string
}

export interface Quota {
  used: number
  /** null when the account has no fixed limit. */
  total: number | null
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
}

export interface AccountProfile {
  externalId: string
  email?: string
  displayName?: string
  avatarUrl?: string
}

export interface UploadParams {
  parentId: string
  name: string
  /** null when the size isn't known up front (rare; e.g. exported Google Docs). */
  size: number | null
  stream: Readable
  /** Called with the total number of bytes confirmed by the server so far. */
  onProgress?: (bytes: number) => void
  signal?: AbortSignal
}

export interface DownloadResult {
  stream: Readable
  size: number | null
  /** Set when the provider converts the file and the name changes (e.g. Google Docs -> .docx). */
  name?: string
}

/** Operations on one connected account. */
export interface CloudClient {
  /** The id to use for the account's top-level folder. */
  readonly rootId: string
  list(folderId: string): Promise<Entry[]>
  get(id: string): Promise<Entry>
  /** Returns the child folder with this name, creating it if needed. */
  ensureFolder(parentId: string, name: string): Promise<Entry>
  upload(params: UploadParams): Promise<Entry>
  download(id: string, signal?: AbortSignal): Promise<DownloadResult>
  /** Moves to the provider's trash/recycle bin when it has one. */
  delete(id: string): Promise<void>
  /** Server-side copy inside the same account, when the provider supports it. */
  copy?(id: string, parentId: string, name: string): Promise<Entry>
  quota(): Promise<Quota | null>
  folderUrl(folderId: string): string | null
}

export interface AccountContext {
  account: Account
  /** Returns a valid access token, refreshing it when needed (or when `force` is set). */
  token(force?: boolean): Promise<string>
  /** Decrypted provider credentials (used by non-OAuth providers such as Mega). */
  credentials<T>(): T
  /** Persists replacement credentials (e.g. a refreshed Mega session). */
  saveCredentials(value: unknown): Promise<void>
}

export interface OAuthSpec {
  authorizeUrl(opts: { state: string; codeChallenge: string; redirectUri: string; purpose: 'login' | 'connect'; loginHint?: string; forceConsent?: boolean }): string
  exchange(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthTokens>
  refresh(refreshToken: string): Promise<OAuthTokens>
  profile(accessToken: string): Promise<AccountProfile>
}

export interface ProviderDef {
  id: ProviderId
  label: string
  auth: 'oauth' | 'password' | 'none'
  enabled(): boolean
  oauth?: OAuthSpec
  client(ctx: AccountContext): CloudClient
}

/** fetch() with a bearer token that is refreshed and retried once on 401. */
export async function authedFetch(ctx: AccountContext, url: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string) => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  }
  let res = await send(await ctx.token())
  if (res.status === 401 && !(init.body instanceof ReadableStream)) {
    await res.body?.cancel()
    res = await send(await ctx.token(true))
  }
  return res
}
