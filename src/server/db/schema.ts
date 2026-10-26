import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export type ProviderId = 'gdrive' | 'dropbox' | 'onedrive' | 'mega' | 'local'

export interface Destination {
  accountId: string
  folderId: string
  /** Human readable path, only for display. */
  folderName: string
}

export interface UserSettings {
  defaultDestination?: Destination
}

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  googleSub: text('google_sub').unique(),
  settings: jsonb('settings').$type<UserSettings>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable('sessions', {
  /** sha256 of the cookie token; the raw token is never stored. */
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A connected cloud storage account. A user can connect several, even of the same provider. */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ProviderId>().notNull(),
    externalId: text('external_id').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    /** Encrypted JSON: { refreshToken } for OAuth providers, a session for Mega. */
    credentials: text('credentials').notNull(),
    /** Encrypted short-lived access token. */
    accessToken: text('access_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    needsReauth: boolean('needs_reauth').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('accounts_user_provider_external').on(t.userId, t.provider, t.externalId)],
)

export type JobKind = 'torrent' | 'transfer' | 'url'
export type JobStatus =
  | 'queued'
  | 'starting'
  | 'metadata'
  | 'awaiting_selection'
  | 'downloading'
  | 'uploading'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Statuses during which a worker owns the job. */
export const ACTIVE_STATUSES: JobStatus[] = ['starting', 'metadata', 'downloading', 'uploading', 'transferring']
export const FINISHED_STATUSES: JobStatus[] = ['completed', 'failed', 'cancelled']

export interface TorrentInput {
  magnet?: string
  infoHash?: string
  chooseFiles: boolean
  /** Set once the user has picked files (or immediately when chooseFiles is false). */
  selectionMade: boolean
}

export interface TransferItem {
  id: string
  name: string
  isFolder: boolean
  size?: number | null
}

export interface TransferInput {
  sourceAccountId: string
  items: TransferItem[]
  mode: 'copy' | 'move'
}

export interface UrlInput {
  url: string
  /** Set for Google Drive share links: copied through the Drive API instead of downloaded. */
  driveSource?: { accountId: string; items: TransferItem[] }
}

export interface JobFile {
  index: number
  /** Path relative to the job root, using "/" separators. */
  path: string
  size: number | null
  selected: boolean
  status: 'pending' | 'uploading' | 'done' | 'failed'
  uploaded: number
  downloaded?: number
  /** For transfers: the id of the file in the source cloud. */
  sourceId?: string
  remoteId?: string
  error?: string
}

export interface JobResult {
  url?: string
  folderId?: string
}

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<JobKind>().notNull(),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    name: text('name').notNull(),
    input: jsonb('input').$type<TorrentInput | TransferInput | UrlInput>().notNull(),
    /** Base64 .torrent metadata, kept so a job can resume or wait for file selection. */
    torrentFile: text('torrent_file'),
    destination: jsonb('destination').$type<Destination>().notNull(),
    files: jsonb('files').$type<JobFile[]>().notNull().default([]),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
    downloadedBytes: bigint('downloaded_bytes', { mode: 'number' }).notNull().default(0),
    uploadedBytes: bigint('uploaded_bytes', { mode: 'number' }).notNull().default(0),
    downloadSpeed: integer('download_speed').notNull().default(0),
    uploadSpeed: integer('upload_speed').notNull().default(0),
    peers: integer('peers').notNull().default(0),
    /** Short status line for the UI, e.g. "Waiting for disk space". */
    note: text('note'),
    error: text('error'),
    result: jsonb('result').$type<JobResult>(),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    workerId: text('worker_id'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    notBefore: timestamp('not_before', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`now()`),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_user_created').on(t.userId, t.createdAt),
    index('jobs_status_created').on(t.status, t.createdAt),
    index('jobs_user_updated').on(t.userId, t.updatedAt),
  ],
)

export type User = typeof users.$inferSelect
export type Account = typeof accounts.$inferSelect
export type Job = typeof jobs.$inferSelect
