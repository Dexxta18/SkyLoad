import { UserError } from './lib/http.js'

export type ParsedLink =
  | { kind: 'gdrive'; id: string; isFolder: boolean | null; resourceKey?: string; url: string }
  | { kind: 'http'; url: string }

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'])
const DRIVE_ID = /^[\w-]{10,}$/

/** Recognises Google Drive and Dropbox share links; everything else is a plain download. */
export function parseLink(input: string): ParsedLink {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new UserError('That does not look like a link. It should start with https://')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UserError('Only http:// and https:// links are supported.')

  if (DRIVE_HOSTS.has(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean)
    const resourceKey = url.searchParams.get('resourcekey') ?? undefined
    const afterD = parts.indexOf('d')
    const afterFolders = parts.indexOf('folders')
    let id: string | undefined
    let isFolder: boolean | null = null
    if (afterFolders !== -1) {
      id = parts[afterFolders + 1]
      isFolder = true
    } else if (afterD !== -1) {
      id = parts[afterD + 1]
      isFolder = false
    } else {
      id = url.searchParams.get('id') ?? undefined
    }
    if (id && DRIVE_ID.test(id)) return { kind: 'gdrive', id, isFolder, resourceKey, url: url.toString() }
  }

  if (url.hostname === 'www.dropbox.com' || url.hostname === 'dropbox.com') {
    // Share links open a preview page; dl=1 makes them download the file itself.
    url.searchParams.set('dl', '1')
    return { kind: 'http', url: url.toString() }
  }

  return { kind: 'http', url: url.toString() }
}

/** Public download URL for a Drive file shared as "Anyone with the link". */
export function driveDownloadUrl(id: string, resourceKey?: string): string {
  const url = new URL('https://drive.usercontent.google.com/download')
  url.searchParams.set('id', id)
  url.searchParams.set('export', 'download')
  // Skips the "can't scan this file for viruses" page for large files.
  url.searchParams.set('confirm', 't')
  if (resourceKey) url.searchParams.set('resourcekey', resourceKey)
  return url.toString()
}
