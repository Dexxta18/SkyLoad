import { Storage, type MutableFile } from 'megajs'
import { config } from '../config.js'
import { UserError } from '../lib/http.js'
import type { AccountContext, AccountProfile, CloudClient, Entry, ProviderDef } from './types.js'

/** What we persist for Mega: a resumable session, never the password. */
export interface MegaCredentials {
  session: ReturnType<Storage['toJSON']>
}

function toEntry(file: MutableFile): Entry {
  return {
    id: file.nodeId!,
    name: file.name ?? '(encrypted)',
    isFolder: file.directory,
    size: file.directory ? null : (file.size ?? null),
    modifiedAt: file.timestamp ? new Date(file.timestamp * 1000).toISOString() : undefined,
  }
}

/** Mega logins download the whole file tree, so sessions are cached per account. */
const sessions = new Map<string, { storage: Promise<Storage>; at: number }>()
const SESSION_TTL_MS = 10 * 60_000

/** Logs in with email + password (and 2FA code) once, returning a session to store. */
export async function megaLogin(email: string, password: string, secondFactorCode?: string): Promise<{ credentials: MegaCredentials; profile: AccountProfile }> {
  try {
    const storage = await new Storage({ email, password, secondFactorCode: secondFactorCode || undefined, keepalive: false }).ready
    const session = storage.toJSON()
    // toJSON keeps the login options; drop the password so it is never stored.
    session.options = { email } as typeof session.options
    await storage.close()
    return { credentials: { session }, profile: { externalId: storage.user, email, displayName: storage.name || email } }
  } catch (err) {
    const message = String((err as Error).message ?? err)
    if (/EMFAREQUIRED|-26/.test(message)) throw new UserError('This Mega account uses two-factor authentication. Enter the 6-digit code.')
    if (/ENOENT|EINCOMPLETE|-9|-2\b/.test(message)) throw new UserError('Mega rejected that email or password.')
    throw new UserError(`Could not sign in to Mega: ${message}`)
  }
}

function megaClient(ctx: AccountContext): CloudClient {
  const storage = async (): Promise<Storage> => {
    const cached = sessions.get(ctx.account.id)
    if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.storage
    const { session } = ctx.credentials<MegaCredentials>()
    const promise = (async () => {
      const s = Storage.fromJSON({ ...session, options: { ...session.options, keepalive: false } })
      await s.reload(true)
      return s
    })()
    sessions.set(ctx.account.id, { storage: promise, at: Date.now() })
    promise.catch(() => sessions.delete(ctx.account.id))
    return promise
  }

  const node = async (id: string): Promise<MutableFile> => {
    const s = await storage()
    const file = id === 'root' ? s.root : s.files[id]
    if (!file) throw new UserError('That Mega file or folder no longer exists')
    return file
  }

  return {
    rootId: 'root',

    async list(folderId) {
      const folder = await node(folderId)
      return (folder.children ?? []).map(toEntry).sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name))
    },

    async get(id) {
      return toEntry(await node(id))
    },

    async ensureFolder(parentId, name) {
      const parent = await node(parentId)
      const existing = parent.children?.find((c) => c.directory && c.name === name)
      return toEntry(existing ?? (await parent.mkdir(name)))
    },

    async upload({ parentId, name, size, stream, onProgress, signal }) {
      if (size === null) throw new Error('Mega needs the file size up front')
      const parent = await node(parentId)
      const upload = parent.upload({ name, size }) as ReturnType<Storage['upload']>
      let sent = 0
      stream.on('data', (chunk: Buffer) => {
        sent += chunk.length
        onProgress?.(sent)
      })
      const onAbort = () => stream.destroy(new Error('Cancelled'))
      signal?.addEventListener('abort', onAbort, { once: true })
      stream.pipe(upload as unknown as NodeJS.WritableStream)
      try {
        const file = await Promise.race([
          upload.complete,
          new Promise<never>((_, reject) => {
            stream.once('error', reject)
            upload.once('error', reject)
          }),
        ])
        return toEntry(file)
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },

    async download(id) {
      const file = await node(id)
      return { stream: file.download({}), size: file.size ?? null }
    },

    async delete(id) {
      await (await node(id)).delete(false)
    },

    async copy(id, parentId) {
      const file = await node(id)
      await file.copyTo(await node(parentId))
      return toEntry(file)
    },

    async quota() {
      const info = await (await storage()).getAccountInfo()
      return { used: info.spaceUsed, total: info.spaceTotal || null }
    },

    folderUrl(folderId) {
      return folderId === 'root' ? 'https://mega.nz/fm' : `https://mega.nz/fm/${folderId}`
    },
  }
}

export function forgetMegaSession(accountId: string) {
  sessions.delete(accountId)
}

export const mega: ProviderDef = {
  id: 'mega',
  label: 'Mega',
  auth: 'password',
  enabled: () => config.megaEnabled,
  client: megaClient,
}
