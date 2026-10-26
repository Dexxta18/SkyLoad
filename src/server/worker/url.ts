import fs from 'node:fs'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { clientFor, getAccount } from '../accounts.js'
import { config } from '../config.js'
import type { UrlInput } from '../db/schema.js'
import { UserError } from '../lib/http.js'
import { openUrl } from '../lib/safe-fetch.js'
import { getProvider } from '../providers/index.js'
import type { JobRun } from './run.js'
import { formatBytes } from './torrent.js'
import { runTransferJob } from './transfer.js'
import { safeName } from './uploader.js'

/** Destinations that can take a stream of unknown length; others get a spooled temp file. */
const STREAMS_UNKNOWN_SIZE = new Set(['gdrive', 'dropbox', 'local'])

/**
 * Downloads a link and streams it to the destination cloud. Google Drive share
 * links are handed to the transfer runner, which copies them inside Google.
 */
export async function runUrlJob(run: JobRun): Promise<void> {
  const { job } = run
  const input = job.input as UrlInput
  if (input.driveSource) {
    return runTransferJob(run, { sourceAccountId: input.driveSource.accountId, items: input.driveSource.items, mode: 'copy' })
  }

  const destAccount = await getAccount(job.userId, job.destination.accountId)
  const dest = clientFor(destAccount)
  const max = config.limits.maxTorrentBytes

  run.set({ status: 'downloading', note: 'Connecting…', downloadedBytes: 0, uploadedBytes: 0 })
  await run.flush()

  const source = await openUrl(input.url, { signal: run.signal, allowPrivate: config.links.allowPrivate }).catch((err) => {
    // Drive answers with a sign-in page when a file isn't shared publicly.
    if (err instanceof UserError && new URL(input.url).hostname === 'drive.usercontent.google.com') {
      throw new UserError('That Google Drive file isn\'t shared publicly. Share it as "Anyone with the link" and try again.')
    }
    throw err
  })
  if (source.size !== null && source.size > max) {
    source.body.destroy()
    throw new UserError(`That file is ${formatBytes(source.size)}; the limit is ${formatBytes(max)}.`)
  }
  const name = safeName(destAccount.provider, source.fileName)
  run.set({ name, totalBytes: source.size ?? 0, note: source.size === null ? "Size unknown until it's finished" : null })

  if (source.size !== null) {
    const quota = await dest.quota().catch(() => null)
    if (quota?.total != null && quota.total - quota.used < source.size) {
      source.body.destroy()
      throw new UserError(`Not enough space in ${getProvider(destAccount.provider).label}: this needs ${formatBytes(source.size)}.`)
    }
  }

  let downloaded = 0
  let lastTick = Date.now()
  let lastBytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      downloaded += chunk.length
      if (downloaded > max) return cb(new UserError(`That file is larger than the ${formatBytes(max)} limit.`))
      const now = Date.now()
      if (now - lastTick >= 1000) {
        run.set({ downloadSpeed: Math.round(((downloaded - lastBytes) * 1000) / (now - lastTick)) })
        lastTick = now
        lastBytes = downloaded
      }
      run.set({ downloadedBytes: downloaded })
      cb(null, chunk)
    },
  })

  let spooled: string | undefined
  try {
    let stream: Readable
    let size = source.size
    if (size === null && !STREAMS_UNKNOWN_SIZE.has(destAccount.provider)) {
      // OneDrive and Mega need the size before the first byte: save to disk first.
      spooled = path.join(config.tmpDir, `${job.id}.download`)
      await pipeline(source.body, counter, fs.createWriteStream(spooled), { signal: run.signal })
      size = (await fs.promises.stat(spooled)).size
      stream = fs.createReadStream(spooled)
      run.set({ status: 'uploading', downloadSpeed: 0 })
    } else {
      pipeline(source.body, counter).catch(() => {
        // Errors surface through `counter`, which the upload is reading.
      })
      stream = counter
    }

    const entry = await dest.upload({
      parentId: job.destination.folderId,
      name,
      size,
      stream,
      signal: run.signal,
      onProgress: (bytes) => run.set({ uploadedBytes: bytes }),
    })
    const total = size ?? downloaded
    run.setFiles([{ index: 0, path: name, size: total, selected: true, status: 'done', uploaded: total, remoteId: entry.id }])
    await run.finish('completed', {
      note: null,
      totalBytes: total,
      downloadedBytes: total,
      uploadedBytes: total,
      result: { folderId: job.destination.folderId, url: entry.url ?? dest.folderUrl(job.destination.folderId) ?? undefined },
    })
  } finally {
    source.body.destroy()
    if (spooled) await fs.promises.rm(spooled, { force: true })
  }
}
