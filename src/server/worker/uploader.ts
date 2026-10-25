import type { ProviderId } from '../db/schema.js'
import type { CloudClient, Entry } from '../providers/types.js'

/** Makes a file or folder name acceptable to the destination cloud. */
export function safeName(provider: ProviderId, name: string): string {
  // eslint-disable-next-line no-control-regex
  let out = name.replace(/[\u0000-\u001f/\\]/g, '_').trim()
  if (provider === 'onedrive' || provider === 'dropbox') {
    out = out.replace(/["*:<>?|]/g, '_').replace(/[. ]+$/, '')
  }
  if (!out || out === '.' || out === '..') out = '_'
  return out.slice(0, 255)
}

/** Creates nested folders under a root on demand, remembering what it created. */
export class FolderTree {
  private cache = new Map<string, Promise<Entry>>()

  constructor(
    private client: CloudClient,
    private provider: ProviderId,
    private rootId: string,
  ) {}

  /** Returns the folder id for a list of path segments below the root. */
  async resolve(segments: string[]): Promise<string> {
    let parentId = this.rootId
    for (let i = 0; i < segments.length; i++) {
      const key = segments.slice(0, i + 1).join('/')
      let pending = this.cache.get(key)
      if (!pending) {
        const parent = parentId
        pending = this.client.ensureFolder(parent, safeName(this.provider, segments[i]))
        this.cache.set(key, pending)
        pending.catch(() => this.cache.delete(key))
      }
      parentId = (await pending).id
    }
    return parentId
  }

  async entry(segments: string[]): Promise<Entry | undefined> {
    if (!segments.length) return undefined
    await this.resolve(segments)
    return this.cache.get(segments.join('/'))
  }
}

/** Splits "a/b/c.txt" into folders ["a","b"] and name "c.txt". */
export function splitPath(p: string): { dirs: string[]; name: string } {
  const parts = p.split('/').filter(Boolean)
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] ?? 'file' }
}
