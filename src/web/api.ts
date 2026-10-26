export type ProviderId = 'gdrive' | 'dropbox' | 'onedrive' | 'mega' | 'local'

export interface Destination {
  accountId: string
  folderId: string
  folderName: string
}

export interface Me {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  settings: { defaultDestination?: Destination }
}

export interface AppConfig {
  providers: { id: ProviderId; label: string; auth: 'oauth' | 'password' | 'none' }[]
  devLogin: boolean
  googleLogin: boolean
  driveScope: 'full' | 'file'
  limits: { maxTorrentBytes: number; maxActiveJobsPerUser: number }
}

export interface Account {
  id: string
  provider: ProviderId
  email: string | null
  displayName: string | null
  needsReauth: boolean
  limitedScope: boolean
  createdAt: string
}

export interface Entry {
  id: string
  name: string
  isFolder: boolean
  size: number | null
  modifiedAt?: string
}

export type JobStatus = 'queued' | 'starting' | 'metadata' | 'awaiting_selection' | 'downloading' | 'uploading' | 'transferring' | 'completed' | 'failed' | 'cancelled'

export interface JobSummary {
  id: string
  kind: 'torrent' | 'transfer' | 'url'
  status: JobStatus
  name: string
  destination: Destination
  totalBytes: number
  downloadedBytes: number
  uploadedBytes: number
  downloadSpeed: number
  uploadSpeed: number
  peers: number
  note: string | null
  error: string | null
  result: { url?: string; folderId?: string } | null
  cancelRequested: boolean
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  fileCount: number
  mode?: 'copy' | 'move' | null
}

export interface JobFile {
  index: number
  path: string
  size: number | null
  selected: boolean
  status: 'pending' | 'uploading' | 'done' | 'failed'
  uploaded: number
  error?: string
}

export interface JobDetail extends JobSummary {
  files: JobFile[]
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status)
  return data as T
}
