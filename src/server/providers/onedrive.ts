import { Readable } from 'node:stream'
import { buffer as readAll } from 'node:stream/consumers'
import { config } from '../config.js'
import { chunksWithLast } from '../lib/chunks.js'
import { asBody, ensureOk, fetchJson, HttpError, withRetry } from '../lib/http.js'
import { authedFetch, type AccountContext, type CloudClient, type Entry, type ProviderDef } from './types.js'

const GRAPH = 'https://graph.microsoft.com/v1.0'
/** Must be a multiple of 320 KiB and at most 60 MiB. */
const CHUNK_SIZE = 320 * 1024 * 50
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024
const SCOPES = 'offline_access openid email profile User.Read Files.ReadWrite.All'

interface DriveItem {
  id: string
  name: string
  size?: number
  folder?: object
  file?: { mimeType?: string }
  lastModifiedDateTime?: string
  webUrl?: string
}

function toEntry(item: DriveItem): Entry {
  return {
    id: item.id,
    name: item.name,
    isFolder: Boolean(item.folder),
    size: item.folder ? null : (item.size ?? null),
    modifiedAt: item.lastModifiedDateTime,
    mimeType: item.file?.mimeType,
    url: item.webUrl,
  }
}

const itemPath = (id: string) => (id === 'root' ? '/me/drive/root' : `/me/drive/items/${encodeURIComponent(id)}`)

function onedriveClient(ctx: AccountContext): CloudClient {
  const graph = <T>(path: string, init: RequestInit = {}, what = 'OneDrive request'): Promise<T> =>
    withRetry(async () => {
      const res = await authedFetch(ctx, path.startsWith('http') ? path : `${GRAPH}${path}`, init)
      await ensureOk(res, what)
      return (res.status === 204 ? undefined : await res.json()) as T
    })

  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    rootId: 'root',

    async list(folderId) {
      const entries: Entry[] = []
      let next: string | undefined = `${itemPath(folderId)}/children?$top=999&$select=id,name,size,folder,file,lastModifiedDateTime,webUrl`
      while (next) {
        const page: { value: DriveItem[]; '@odata.nextLink'?: string } = await graph(next, {}, 'Listing OneDrive folder')
        entries.push(...page.value.map(toEntry))
        next = page['@odata.nextLink']
      }
      return entries.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name))
    },

    async get(id) {
      return toEntry(await graph<DriveItem>(itemPath(id)))
    },

    async ensureFolder(parentId, name) {
      try {
        return toEntry(await graph<DriveItem>(`${itemPath(parentId)}/children`, json({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }), 'Creating OneDrive folder'))
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) {
          return toEntry(await graph<DriveItem>(`${itemPath(parentId)}:/${encodeURIComponent(name)}`))
        }
        throw err
      }
    },

    async upload({ parentId, name, size, stream, onProgress, signal }) {
      const target = `${itemPath(parentId)}:/${encodeURIComponent(name)}:`
      if (size !== null && size <= SIMPLE_UPLOAD_LIMIT) {
        const body = await readAll(stream)
        const item = await graph<DriveItem>(`${target}/content?@microsoft.graph.conflictBehavior=rename`, { method: 'PUT', body: asBody(body), signal }, 'Uploading to OneDrive')
        onProgress?.(body.length)
        return toEntry(item)
      }
      if (size === null) throw new Error('OneDrive needs the file size up front')

      const session = await graph<{ uploadUrl: string }>(`${target}/createUploadSession`, json({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }), 'Starting OneDrive upload')
      let offset = 0
      for await (const { chunk } of chunksWithLast(stream, CHUNK_SIZE)) {
        if (chunk.length === 0) break
        // The upload URL is pre-authenticated; sending a bearer token to it is rejected.
        const res = await withRetry(
          async () =>
            ensureOk(
              await fetch(session.uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${size}` },
                body: asBody(chunk),
                signal,
              }),
              'Uploading to OneDrive',
            ),
          { signal, retries: 8 },
        )
        offset += chunk.length
        onProgress?.(offset)
        if (res.status === 200 || res.status === 201) return toEntry((await res.json()) as DriveItem)
        await res.body?.cancel()
      }
      throw new Error('OneDrive did not finish the upload')
    },

    async download(id, signal) {
      const item = await graph<DriveItem>(itemPath(id))
      // Graph answers with a redirect to a pre-authenticated download URL.
      const res = await withRetry(async () => ensureOk(await authedFetch(ctx, `${GRAPH}${itemPath(id)}/content`, { signal }), 'Downloading from OneDrive'), { signal })
      return { stream: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), size: item.size ?? null }
    },

    async delete(id) {
      await graph(itemPath(id), { method: 'DELETE' })
    },

    async quota() {
      const drive = await graph<{ quota?: { used: number; total: number } }>('/me/drive?$select=quota')
      return drive.quota ? { used: drive.quota.used, total: drive.quota.total } : null
    },

    folderUrl() {
      // Item web URLs come back from the API (Entry.url); there's no stable pattern to build one.
      return 'https://onedrive.live.com/'
    },
  }
}

const tokenUrl = () => `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`

async function tokenRequest(params: Record<string, string>) {
  const res = await fetchJson<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, scope: SCOPES, ...params }),
    what: 'Microsoft token request',
  })
  return { accessToken: res.access_token, refreshToken: res.refresh_token, expiresIn: res.expires_in, scope: res.scope }
}

export const onedrive: ProviderDef = {
  id: 'onedrive',
  label: 'OneDrive',
  auth: 'oauth',
  enabled: () => Boolean(config.microsoft.clientId && config.microsoft.clientSecret),
  oauth: {
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const params = new URLSearchParams({
        client_id: config.microsoft.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      })
      return `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/authorize?${params}`
    },
    exchange: (code, codeVerifier, redirectUri) => tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
    // Microsoft rotates refresh tokens; the caller stores the new one.
    refresh: (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async profile(accessToken) {
      const me = await fetchJson<{ id: string; displayName?: string; mail?: string; userPrincipalName?: string }>(`${GRAPH}/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        what: 'Microsoft profile request',
      })
      return { externalId: me.id, email: me.mail ?? me.userPrincipalName, displayName: me.displayName }
    },
  },
  client: onedriveClient,
}
