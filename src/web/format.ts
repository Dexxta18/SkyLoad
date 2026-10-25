import type { JobStatus, ProviderId } from './api'

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export const speed = (bps: number) => `${bytes(bps)}/s`

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  return `${h}h ${Math.round((seconds % 3600) / 60)}m`
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

export const providerLabel: Record<ProviderId, string> = {
  gdrive: 'Google Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
  mega: 'Mega',
  local: 'Local folder',
}

export const statusLabel: Record<JobStatus, string> = {
  queued: 'Queued',
  starting: 'Starting',
  metadata: 'Fetching details',
  awaiting_selection: 'Waiting for you',
  downloading: 'Downloading',
  uploading: 'Uploading',
  transferring: 'Transferring',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const isActive = (s: JobStatus) => ['starting', 'metadata', 'downloading', 'uploading', 'transferring'].includes(s)
export const isFinished = (s: JobStatus) => ['completed', 'failed', 'cancelled'].includes(s)
