import { Readable } from 'node:stream'
import { config } from '../config.js'
import { chunksWithLast } from '../lib/chunks.js'
import { asBody, ensureOk, fetchJson, HttpError, withRetry } from '../lib/http.js'
import { authedFetch, type AccountContext, type CloudClient, type Entry, type ProviderDef } from './types.js'

const API = 'https://api.dropboxapi.com/2'
const CONTENT = 'https://content.dropboxapi.com/2'
/** Dropbox accepts up to 150 MB per call; 4 MiB multiples are fastest. */
const CHUNK_SIZE = 32 * 1024 * 1024

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted'
  id: string
  name: string
  path_lower?: string
  path_display?: string
  size?: number
  server_modified?: string
}

// Dropbox ids are paths ("" is the root). Paths are case-insensitive but we keep
// the display casing so new folders look right.
function toEntry(e: DropboxEntry): Entry {
  return {
    id: e.path_display ?? e.path_lower ?? e.id,
    name: e.name,
    isFolder: e['.tag'] === 'folder',
    size: e.size ?? null,
    modifiedAt: e.server_modified,
  }
}

/** The Dropbox-API-Arg header must be ASCII, so non-ASCII characters are \u-escaped. */
export function dropboxArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

const root = (id: string) => (id === 'root' || id === '/' ? '' : id)

function dropboxClient(ctx: AccountContext): CloudClient {
  const rpc = <T>(endpoint: string, args: unknown, what = 'Dropbox request'): Promise<T> =>
    withRetry(async () => {
      const res = await authedFetch(ctx, `${API}${endpoint}`, {
        method: 'POST',
        headers: args === null ? {} : { 'Content-Type': 'application/json' },
        body: args === null ? undefined : JSON.stringify(args),
      })
      await ensureOk(res, what)
      return (await res.json()) as T
    })

  const content = async (endpoint: string, args: unknown, body: Buffer | undefined, signal?: AbortSignal) => {
    const res = await authedFetch(ctx, `${CONTENT}${endpoint}`, {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': dropboxArg(args), ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
      body: body && asBody(body),
      signal,
    })
    return ensureOk(res, 'Dropbox upload')
  }

  return {
    rootId: 'root',

    async list(folderId) {
      const entries: Entry[] = []
      let page = await rpc<{ entries: DropboxEntry[]; cursor: string; has_more: boolean }>('/files/list_folder', { path: root(folderId), limit: 2000 }, 'Listing Dropbox folder')
      entries.push(...page.entries.filter((e) => e['.tag'] !== 'deleted').map(toEntry))
      while (page.has_more) {
        page = await rpc('/files/list_folder/continue', { cursor: page.cursor })
        entries.push(...page.entries.filter((e) => e['.tag'] !== 'deleted').map(toEntry))
      }
      return entries.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name))
    },

    async get(id) {
      if (!root(id)) return { id: 'root', name: 'Dropbox', isFolder: true, size: null }
      return toEntry(await rpc<DropboxEntry>('/files/get_metadata', { path: id }))
    },

    async ensureFolder(parentId, name) {
      const path = `${root(parentId)}/${name}`
      try {
        const res = await rpc<{ metadata: DropboxEntry }>('/files/create_folder_v2', { path, autorename: false }, 'Creating Dropbox folder')
        return toEntry({ ...res.metadata, '.tag': 'folder' })
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) {
          const existing = await rpc<DropboxEntry>('/files/get_metadata', { path })
          if (existing['.tag'] === 'folder') return toEntry(existing)
        }
        throw err
      }
    },

    async upload({ parentId, name, stream, onProgress, signal }) {
      const path = `${root(parentId)}/${name}`
      let sessionId: string | undefined
      let offset = 0
      for await (const { chunk, last } of chunksWithLast(stream, CHUNK_SIZE)) {
        if (!sessionId && last) {
          // Small file: one request.
          const res = await withRetry(() => content('/files/upload', { path, mode: 'add', autorename: true, mute: true }, chunk, signal), { signal })
          onProgress?.(chunk.length)
          return toEntry({ ...((await res.json()) as DropboxEntry), '.tag': 'file' })
        }
        if (!sessionId) {
          const res = await withRetry(() => content('/files/upload_session/start', { close: false }, chunk, signal), { signal })
          sessionId = ((await res.json()) as { session_id: string }).session_id
        } else if (!last) {
          await withRetry(() => content('/files/upload_session/append_v2', { cursor: { session_id: sessionId, offset }, close: false }, chunk, signal).then((r) => r.body?.cancel()), {
            signal,
          })
        } else {
          const res = await withRetry(
            () => content('/files/upload_session/finish', { cursor: { session_id: sessionId, offset }, commit: { path, mode: 'add', autorename: true, mute: true } }, chunk, signal),
            { signal },
          )
          onProgress?.(offset + chunk.length)
          return toEntry({ ...((await res.json()) as DropboxEntry), '.tag': 'file' })
        }
        offset += chunk.length
        onProgress?.(offset)
      }
      throw new Error('Upload stream ended unexpectedly')
    },

    async download(id, signal) {
      const res = await withRetry(
        async () => ensureOk(await authedFetch(ctx, `${CONTENT}/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': dropboxArg({ path: id }) }, signal }), 'Downloading from Dropbox'),
        { signal },
      )
      const meta = JSON.parse(res.headers.get('dropbox-api-result') ?? '{}') as DropboxEntry
      return { stream: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), size: meta.size ?? null }
    },

    async delete(id) {
      await rpc('/files/delete_v2', { path: id })
    },

    async copy(id, parentId, name) {
      const res = await rpc<{ metadata: DropboxEntry }>('/files/copy_v2', { from_path: id, to_path: `${root(parentId)}/${name}`, autorename: true })
      return toEntry(res.metadata)
    },

    async quota() {
      const usage = await rpc<{ used: number; allocation: { allocated?: number } }>('/users/get_space_usage', null)
      return { used: usage.used, total: usage.allocation.allocated ?? null }
    },

    folderUrl(folderId) {
      return `https://www.dropbox.com/home${encodeURI(root(folderId))}`
    },
  }
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetchJson<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.dropbox.appKey, client_secret: config.dropbox.appSecret, ...params }),
    what: 'Dropbox token request',
  })
  return { accessToken: res.access_token, refreshToken: res.refresh_token, expiresIn: res.expires_in, scope: res.scope }
}

export const dropbox: ProviderDef = {
  id: 'dropbox',
  label: 'Dropbox',
  auth: 'oauth',
  enabled: () => Boolean(config.dropbox.appKey && config.dropbox.appSecret),
  oauth: {
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const params = new URLSearchParams({
        client_id: config.dropbox.appKey,
        redirect_uri: redirectUri,
        response_type: 'code',
        token_access_type: 'offline',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        force_reapprove: 'false',
      })
      return `https://www.dropbox.com/oauth2/authorize?${params}`
    },
    exchange: (code, codeVerifier, redirectUri) => tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
    refresh: (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async profile(accessToken) {
      const me = await fetchJson<{ account_id: string; email: string; name: { display_name: string }; profile_photo_url?: string }>(`${API}/users/get_current_account`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        what: 'Dropbox profile request',
      })
      return { externalId: me.account_id, email: me.email, displayName: me.name.display_name, avatarUrl: me.profile_photo_url }
    },
  },
  client: dropboxClient,
}
