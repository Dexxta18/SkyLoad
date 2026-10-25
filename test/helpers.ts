import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** Sets env for an isolated, fully local server before any app module is imported. */
export function setupEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skyload-test-'))
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    DATA_DIR: path.join(base, 'data'),
    PGLITE_MEMORY: '1',
    DEV_LOGIN: '1',
    LOCAL_PROVIDER_DIR: path.join(base, 'cloud'),
    TORRENT_DHT: 'false',
    ALLOW_PRIVATE_TRACKERS: '1',
    WORKER_POLL_MS: '200',
    MIN_FREE_DISK_GB: '0',
    APP_URL: 'http://localhost:3000',
  })
  return base
}

export function sha1File(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
