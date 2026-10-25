import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { config } from '../config.js'
import { UserError } from '../lib/http.js'
import type { CloudClient, Entry, ProviderDef } from './types.js'

/**
 * A pretend cloud backed by a folder on disk (LOCAL_PROVIDER_DIR). Only for
 * tests and local development; it is never enabled unless that variable is set.
 */
function localClient(accountId: string): CloudClient {
  const base = path.join(config.localProviderDir ?? '/nonexistent', accountId)
  fs.mkdirSync(base, { recursive: true })

  const resolve = (id: string) => {
    const full = path.resolve(base, id === 'root' ? '.' : id)
    if (full !== base && !full.startsWith(base + path.sep)) throw new UserError('Invalid path')
    return full
  }
  const toEntry = (full: string): Entry => {
    const stat = fs.statSync(full)
    const rel = path.relative(base, full).split(path.sep).join('/')
    return { id: rel || 'root', name: path.basename(full), isFolder: stat.isDirectory(), size: stat.isDirectory() ? null : stat.size, modifiedAt: stat.mtime.toISOString() }
  }

  return {
    rootId: 'root',
    async list(folderId) {
      const dir = resolve(folderId)
      return fs
        .readdirSync(dir)
        .map((name) => toEntry(path.join(dir, name)))
        .sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name))
    },
    async get(id) {
      return toEntry(resolve(id))
    },
    async ensureFolder(parentId, name) {
      const dir = path.join(resolve(parentId), name)
      fs.mkdirSync(dir, { recursive: true })
      return toEntry(dir)
    },
    async upload({ parentId, name, stream, onProgress, signal }) {
      const target = path.join(resolve(parentId), name)
      let sent = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          sent += chunk.length
          onProgress?.(sent)
          cb(null, chunk)
        },
      })
      await pipeline(stream, counter, fs.createWriteStream(target), { signal })
      return toEntry(target)
    },
    async download(id) {
      const full = resolve(id)
      return { stream: fs.createReadStream(full), size: fs.statSync(full).size }
    },
    async delete(id) {
      fs.rmSync(resolve(id), { recursive: true, force: true })
    },
    async quota() {
      return null
    },
    folderUrl() {
      return null
    },
  }
}

export const local: ProviderDef = {
  id: 'local',
  label: 'Local folder (dev)',
  auth: 'none',
  enabled: () => Boolean(config.localProviderDir),
  client: (ctx) => localClient(ctx.account.id),
}
