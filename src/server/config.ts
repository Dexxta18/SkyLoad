import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const env = process.env

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback
}

const isProduction = env.NODE_ENV === 'production'
const dataDir = path.resolve(env.DATA_DIR ?? './data')
fs.mkdirSync(dataDir, { recursive: true })

/**
 * ENCRYPTION_KEY protects stored cloud credentials and signs cookies. It must be
 * set (32 random bytes, base64 or hex) in production. In development a key is
 * generated once and kept in the data directory so restarts don't log you out.
 */
function loadEncryptionKey(): Buffer {
  const raw = env.ENCRYPTION_KEY
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (use: openssl rand -base64 32)')
    return key
  }
  if (isProduction) throw new Error('ENCRYPTION_KEY is required in production (generate one with: openssl rand -base64 32)')
  const keyFile = path.join(dataDir, '.dev-encryption-key')
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 })
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64')
}

const port = num(env.PORT, 3000)
const role = (env.ROLE ?? 'all') as 'all' | 'web' | 'worker'
if (!['all', 'web', 'worker'].includes(role)) throw new Error('ROLE must be one of: all, web, worker')
if (isProduction && role !== 'worker' && !env.APP_URL) throw new Error('APP_URL is required in production (e.g. https://skyload.example.com)')

export const config = {
  isProduction,
  role,
  port,
  host: env.HOST ?? '0.0.0.0',
  /** Public URL of the app, used to build OAuth redirect URLs. */
  appUrl: (env.APP_URL ?? `http://localhost:${isProduction ? port : 5173}`).replace(/\/$/, ''),
  dataDir,
  downloadsDir: path.join(dataDir, 'downloads'),
  tmpDir: path.join(dataDir, 'tmp'),
  databaseUrl: env.DATABASE_URL || undefined,
  encryptionKey: loadEncryptionKey(),
  trustProxy: bool(env.TRUST_PROXY, isProduction),

  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    /**
     * "full" asks for the `drive` scope (browse everything, needed for transfers out
     * of Drive). "file" asks for `drive.file`, which Google treats as non-sensitive:
     * torrents still upload fine, but the app only sees files and folders it created.
     */
    driveScope: (env.GOOGLE_DRIVE_SCOPE ?? 'full') as 'full' | 'file',
  },
  dropbox: {
    appKey: env.DROPBOX_APP_KEY ?? '',
    appSecret: env.DROPBOX_APP_SECRET ?? '',
  },
  microsoft: {
    clientId: env.MICROSOFT_CLIENT_ID ?? '',
    clientSecret: env.MICROSOFT_CLIENT_SECRET ?? '',
    tenant: env.MICROSOFT_TENANT ?? 'common',
  },
  megaEnabled: bool(env.MEGA_ENABLED, true),
  /** Test/dev only: a fake "cloud" backed by a local folder. */
  localProviderDir: env.LOCAL_PROVIDER_DIR ? path.resolve(env.LOCAL_PROVIDER_DIR) : undefined,
  /** Dev only: lets you sign in with any email, without Google. Never enabled in production. */
  devLogin: !isProduction && bool(env.DEV_LOGIN, false),

  worker: {
    id: env.WORKER_ID ?? `${os.hostname()}-${process.pid}`,
    concurrency: num(env.WORKER_CONCURRENCY, 3),
    pollIntervalMs: num(env.WORKER_POLL_MS, 2000),
  },
  limits: {
    maxActiveJobsPerUser: num(env.MAX_ACTIVE_JOBS_PER_USER, 2),
    maxQueuedJobsPerUser: num(env.MAX_QUEUED_JOBS_PER_USER, 20),
    maxTorrentBytes: num(env.MAX_TORRENT_SIZE_GB, 50) * 1024 ** 3,
    minFreeDiskBytes: num(env.MIN_FREE_DISK_GB, 2) * 1024 ** 3,
    metadataTimeoutMs: num(env.METADATA_TIMEOUT_MINUTES, 10) * 60_000,
    /** A torrent that makes no progress for this long is failed instead of hogging a slot. */
    stallTimeoutMs: num(env.STALL_TIMEOUT_MINUTES, 30) * 60_000,
  },
  torrent: {
    /** Fixed port for incoming peer connections. 0 picks a random free port per job. */
    port: num(env.TORRENT_PORT, 0),
    dht: bool(env.TORRENT_DHT, true),
    /** Off by default: stops magnets from pointing the worker at internal addresses. */
    allowPrivateTrackers: bool(env.ALLOW_PRIVATE_TRACKERS, false),
    downloadLimit: num(env.TORRENT_DOWNLOAD_LIMIT_KBPS, 0) * 1024 || -1,
    uploadLimit: num(env.TORRENT_UPLOAD_LIMIT_KBPS, 0) * 1024 || -1,
  },
  links: {
    /** Off by default: stops download links from reaching internal addresses (e.g. the cloud metadata server). */
    allowPrivate: bool(env.ALLOW_PRIVATE_URLS, false),
  },
}

fs.mkdirSync(config.downloadsDir, { recursive: true })
fs.mkdirSync(config.tmpDir, { recursive: true })

export type Config = typeof config
