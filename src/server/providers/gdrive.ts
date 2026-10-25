import { Readable } from 'node:stream'
import { config } from '../config.js'
import { chunksWithLast } from '../lib/chunks.js'
import { asBody, ensureOk, fetchJson, HttpError, withRetry } from '../lib/http.js'
import { authedFetch, type AccountContext, type CloudClient, type Entry, type ProviderDef } from './types.js'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink'
/** Must be a multiple of 256 KiB. */
export const GDRIVE_CHUNK_SIZE = 16 * 1024 * 1024

/** Google-native documents have no bytes of their own; they are exported instead. */
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: '.pdf' },
}

export const DRIVE_SCOPE = config.google.driveScope === 'file' ? 'https://www.googleapis.com/auth/drive.file' : 'https://www.googleapis.com/auth/drive'
export const LOGIN_SCOPES = ['openid', 'email', 'profile']

interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  webViewLink?: string
}

function toEntry(f: DriveFile): Entry {
  return {
    id: f.id,
    name: f.name,
    isFolder: f.mimeType === FOLDER_MIME,
    size: f.size !== undefined ? Number(f.size) : null,
    modifiedAt: f.modifiedTime,
    mimeType: f.mimeType,
    url: f.webViewLink,
  }
}

/** Escapes a value for use inside a single-quoted Drive query string. */
function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function driveClient(ctx: AccountContext, apiBase = API, uploadBase = UPLOAD_API): CloudClient {
  const api = async <T>(path: string, init: RequestInit = {}, what = 'Google Drive request'): Promise<T> =>
    withRetry(async () => {
      const res = await authedFetch(ctx, `${apiBase}${path}`, init)
      await ensureOk(res, what)
      return (res.status === 204 ? undefined : await res.json()) as T
    })

  const client: CloudClient = {
    rootId: 'root',

    async list(folderId) {
      const entries: Entry[] = []
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({
          q: `'${q(folderId)}' in parents and trashed = false`,
          fields: `nextPageToken,files(${FIELDS})`,
          pageSize: '1000',
          orderBy: 'folder,name',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        })
        if (pageToken) params.set('pageToken', pageToken)
        const page = await api<{ files: DriveFile[]; nextPageToken?: string }>(`/files?${params}`, {}, 'Listing Google Drive folder')
        // Shortcuts point elsewhere and can't be downloaded directly; hide them.
        entries.push(...page.files.filter((f) => f.mimeType !== 'application/vnd.google-apps.shortcut').map(toEntry))
        pageToken = page.nextPageToken
      } while (pageToken)
      return entries
    },

    async get(id) {
      return toEntry(await api<DriveFile>(`/files/${encodeURIComponent(id)}?fields=${FIELDS}&supportsAllDrives=true`))
    },

    async ensureFolder(parentId, name) {
      const params = new URLSearchParams({
        q: `name = '${q(name)}' and '${q(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: `files(${FIELDS})`,
        pageSize: '1',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      })
      const existing = await api<{ files: DriveFile[] }>(`/files?${params}`)
      if (existing.files[0]) return toEntry(existing.files[0])
      const created = await api<DriveFile>(
        `/files?fields=${FIELDS}&supportsAllDrives=true`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }) },
        'Creating Google Drive folder',
      )
      return toEntry(created)
    },

    async upload({ parentId, name, size, stream, onProgress, signal }) {
      // 1. Open a resumable upload session.
      const sessionUrl = await withRetry(async () => {
        const res = await authedFetch(ctx, `${uploadBase}/files?uploadType=resumable&supportsAllDrives=true&fields=${FIELDS}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            ...(size !== null ? { 'X-Upload-Content-Length': String(size) } : {}),
          },
          body: JSON.stringify({ name, parents: [parentId] }),
          signal,
        })
        await ensureOk(res, 'Starting Google Drive upload')
        const location = res.headers.get('location')
        if (!location) throw new Error('Google Drive did not return an upload URL')
        return location
      }, { signal })

      // 2. Send fixed-size chunks. Each chunk is kept in memory until Google confirms
      //    it, so a dropped connection resumes from the last byte the server has.
      let offset = 0
      for await (const { chunk, last } of chunksWithLast(stream, GDRIVE_CHUNK_SIZE)) {
        const total = last ? offset + chunk.length : size
        let sent = 0
        const result = await withRetry(
          async (attempt) => {
            if (attempt > 0) {
              const confirmed = await queryUploadOffset(sessionUrl, total, signal)
              if (confirmed === 'complete') return 'complete' as const
              sent = Math.max(0, confirmed - offset)
            }
            const body = chunk.subarray(sent)
            const start = offset + sent
            const range = body.length === 0 ? `bytes */${total ?? '*'}` : `bytes ${start}-${start + body.length - 1}/${total ?? '*'}`
            const res = await authedFetch(ctx, sessionUrl, { method: 'PUT', headers: { 'Content-Range': range }, body: asBody(body), signal })
            if (res.status === 308) {
              await res.body?.cancel()
              const confirmed = rangeEnd(res.headers.get('range'))
              if (confirmed < start + body.length) {
                // Partial acceptance: resend the remainder.
                sent = Math.max(0, confirmed - offset)
                throw new HttpError('Google Drive accepted part of a chunk', 503)
              }
              return 'continue' as const
            }
            await ensureOk(res, 'Uploading to Google Drive')
            return (await res.json()) as DriveFile
          },
          { signal, retries: 8 },
        )
        offset += chunk.length
        onProgress?.(offset)
        if (typeof result === 'object') return toEntry(result)
        if (result === 'complete') return lookupUploaded(client, parentId, name)
        if (last) throw new Error('Google Drive did not finish the upload')
      }
      throw new Error('Upload stream ended unexpectedly')
    },

    async download(id, signal) {
      const meta = await api<DriveFile>(`/files/${encodeURIComponent(id)}?fields=${FIELDS}&supportsAllDrives=true`)
      const exportAs = meta.mimeType.startsWith('application/vnd.google-apps.') ? (EXPORTS[meta.mimeType] ?? { mime: 'application/pdf', ext: '.pdf' }) : undefined
      const url = exportAs
        ? `${apiBase}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportAs.mime)}`
        : `${apiBase}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`
      const res = await withRetry(async () => ensureOk(await authedFetch(ctx, url, { signal }), 'Downloading from Google Drive'), { signal })
      return {
        stream: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        size: exportAs ? null : Number(meta.size ?? res.headers.get('content-length') ?? 0),
        name: exportAs && !meta.name.endsWith(exportAs.ext) ? meta.name + exportAs.ext : undefined,
      }
    },

    async delete(id) {
      await api(`/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      })
    },

    async copy(id, parentId, name) {
      return toEntry(
        await api<DriveFile>(`/files/${encodeURIComponent(id)}/copy?fields=${FIELDS}&supportsAllDrives=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parents: [parentId] }),
        }),
      )
    },

    async quota() {
      const about = await api<{ storageQuota: { limit?: string; usage: string } }>('/about?fields=storageQuota')
      return { used: Number(about.storageQuota.usage), total: about.storageQuota.limit ? Number(about.storageQuota.limit) : null }
    },

    folderUrl(folderId) {
      return folderId === 'root' ? 'https://drive.google.com/drive/my-drive' : `https://drive.google.com/drive/folders/${folderId}`
    },
  }

  async function queryUploadOffset(sessionUrl: string, total: number | null, signal?: AbortSignal): Promise<number | 'complete'> {
    const res = await authedFetch(ctx, sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${total ?? '*'}` }, signal })
    if (res.status === 308) {
      await res.body?.cancel()
      return rangeEnd(res.headers.get('range'))
    }
    if (res.ok) {
      await res.body?.cancel()
      return 'complete'
    }
    await ensureOk(res, 'Checking Google Drive upload')
    return 0
  }

  return client
}

/** "bytes=0-1234" -> 1235 (number of bytes the server has). */
function rangeEnd(header: string | null): number {
  const match = header?.match(/bytes=\d+-(\d+)/)
  return match ? Number(match[1]) + 1 : 0
}

async function lookupUploaded(client: CloudClient, parentId: string, name: string): Promise<Entry> {
  const entries = await client.list(parentId)
  const found = entries.filter((e) => e.name === name && !e.isFolder).pop()
  if (!found) throw new Error('Upload finished but the file could not be found in Google Drive')
  return found
}

async function tokenRequest(params: Record<string, string>) {
  const body = new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params })
  const res = await fetchJson<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    what: 'Google token request',
  })
  return { accessToken: res.access_token, refreshToken: res.refresh_token, expiresIn: res.expires_in, scope: res.scope }
}

export const gdrive: ProviderDef = {
  id: 'gdrive',
  label: 'Google Drive',
  auth: 'oauth',
  enabled: () => Boolean(config.google.clientId && config.google.clientSecret),
  oauth: {
    authorizeUrl({ state, codeChallenge, redirectUri, purpose, loginHint, forceConsent }) {
      const params = new URLSearchParams({
        client_id: config.google.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        // Signing in also connects Drive, so the main feature works after one click.
        scope: [...LOGIN_SCOPES, DRIVE_SCOPE].join(' '),
        access_type: 'offline',
        include_granted_scopes: 'true',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // Google only returns a refresh token on consent, which "connect" always needs.
        prompt: purpose === 'connect' || forceConsent ? 'consent select_account' : 'select_account',
      })
      if (loginHint) params.set('login_hint', loginHint)
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
    },
    exchange: (code, codeVerifier, redirectUri) => tokenRequest({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
    refresh: (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async profile(accessToken) {
      const info = await fetchJson<{ sub: string; email?: string; name?: string; picture?: string }>('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        what: 'Google profile request',
      })
      return { externalId: info.sub, email: info.email, displayName: info.name, avatarUrl: info.picture }
    },
  },
  client: (ctx) => driveClient(ctx),
}
