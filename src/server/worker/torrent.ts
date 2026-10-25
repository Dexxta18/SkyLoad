import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import WebTorrent, { type Torrent } from 'webtorrent'
import filenameReservedRegex from 'filename-reserved-regex'
import { clientFor, getAccount } from '../accounts.js'
import { config } from '../config.js'
import type { JobFile, TorrentInput } from '../db/schema.js'
import { sleep, UserError } from '../lib/http.js'
import { log } from '../lib/log.js'
import { getProvider } from '../providers/index.js'
import { PRIVATE_PEER_BLOCKLIST, torrentIdFor } from '../torrent-input.js'
import { releaseDisk, reserveDisk } from './disk.js'
import { ShutdownError, type JobRun } from './run.js'
import { FolderTree, safeName, splitPath } from './uploader.js'

const RESERVED = filenameReservedRegex()

export function formatBytes(n: number): string {
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

/** Where WebTorrent's fs-chunk-store actually writes a file (it strips some characters). */
export function diskPathFor(dir: string, filePath: string): string {
  const full = path.join(path.resolve(dir, path.dirname(filePath)), path.basename(filePath).replace(RESERVED, ''))
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new UserError(`Unsafe path in torrent: ${filePath}`)
  return full
}

let shared: WebTorrent | undefined

/**
 * One BitTorrent client per worker process: it keeps a warm DHT routing table
 * (much faster magnet lookups) and listens on a single peer port.
 */
function torrentClient(): WebTorrent {
  if (shared && !(shared as unknown as { destroyed: boolean }).destroyed) return shared
  const client = new WebTorrent({
    dht: config.torrent.dht,
    lsd: false,
    natUpnp: false,
    natPmp: false,
    webSeeds: false,
    torrentPort: config.torrent.port,
    blocklist: config.torrent.allowPrivateTrackers ? undefined : PRIVATE_PEER_BLOCKLIST,
    downloadLimit: config.torrent.downloadLimit,
    uploadLimit: config.torrent.uploadLimit,
  })
  client.on('error', (err: Error) => log.error({ err }, 'torrent client error'))
  shared = client
  return client
}

export async function closeTorrentClient() {
  const client = shared
  shared = undefined
  if (client) await new Promise<void>((resolve) => client.destroy(() => resolve()))
}

function waitForMetadata(torrent: Torrent, run: JobRun): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((torrent as unknown as { metadata: unknown }).metadata) return resolve()
    const timeout = setTimeout(
      () => finish(new UserError(`Couldn't get this torrent's details within ${Math.round(config.limits.metadataTimeoutMs / 60_000)} minutes. It may have no active peers.`)),
      config.limits.metadataTimeoutMs,
    )
    const peers = setInterval(() => run.set({ peers: torrent.numPeers }), 1000)
    const onMetadata = () => finish()
    const onError = (err: Error) => finish(new UserError(`Torrent error: ${err.message}`))
    const onAbort = () => finish(run.signal.reason)
    function finish(err?: unknown) {
      clearTimeout(timeout)
      clearInterval(peers)
      torrent.off('metadata', onMetadata)
      torrent.off('error', onError)
      run.signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }
    torrent.once('metadata', onMetadata)
    torrent.once('error', onError)
    run.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Downloads a torrent and uploads each file to the destination cloud as soon as
 * that file is complete, so downloading and uploading overlap.
 */
export async function runTorrentJob(run: JobRun): Promise<void> {
  const { job } = run
  const input = job.input as TorrentInput
  const dir = path.join(config.downloadsDir, job.id)
  const destAccount = await getAccount(job.userId, job.destination.accountId)
  const dest = clientFor(destAccount)
  const destLabel = getProvider(destAccount.provider).label

  const client = torrentClient()
  let torrent: Torrent | undefined

  try {
    run.set({ status: 'metadata', note: job.torrentFile ? null : 'Finding peers and fetching torrent details…' })
    await run.flush()

    const torrentId = await torrentIdFor({ magnet: input.magnet, torrentFile: job.torrentFile })
    if (await client.get(torrentId.infoHash)) {
      // Someone else is downloading the same torrent on this worker right now.
      await run.finish('queued', { notBefore: new Date(Date.now() + 60_000), note: 'Waiting for another download of this torrent to finish…' })
      return
    }
    torrent = client.add(torrentId, { path: dir, deselect: true })
    torrent.on('warning', (err: Error) => run.log.debug({ err: err.message }, 'torrent warning'))
    await waitForMetadata(torrent, run)

    if (!run.files.length) {
      run.setFiles(torrent.files.map((f, index): JobFile => ({ index, path: f.path.split(path.sep).join('/'), size: f.length, selected: true, status: 'pending', uploaded: 0 })))
      run.set({ name: torrent.name, torrentFile: Buffer.from(torrent.torrentFile).toString('base64'), totalBytes: torrent.length })
    }

    if (input.chooseFiles && !input.selectionMade) {
      await run.finish('awaiting_selection', { note: null })
      return
    }

    const selected = run.files.filter((f) => f.selected)
    const selectedBytes = selected.reduce((sum, f) => sum + (f.size ?? 0), 0)
    if (selectedBytes > config.limits.maxTorrentBytes) {
      throw new UserError(`This torrent is ${formatBytes(selectedBytes)}; the limit is ${formatBytes(config.limits.maxTorrentBytes)}. Choose fewer files.`)
    }
    const remaining = selected.filter((f) => f.status !== 'done')
    const neededBytes = remaining.reduce((sum, f) => sum + (f.size ?? 0), 0)

    const quota = await dest.quota().catch(() => null)
    if (quota?.total != null && quota.total - quota.used < neededBytes) {
      throw new UserError(`Not enough space in ${destLabel}: this needs ${formatBytes(neededBytes)} but only ${formatBytes(Math.max(0, quota.total - quota.used))} is free.`)
    }

    const disk = await reserveDisk(job.id, neededBytes)
    if (disk === 'too-big') throw new UserError(`This torrent (${formatBytes(neededBytes)}) is larger than this server can hold.`)
    if (disk === 'wait') {
      await run.finish('queued', { notBefore: new Date(Date.now() + 2 * 60_000), note: 'Waiting for disk space on the server…' })
      return
    }

    const tree = new FolderTree(dest, destAccount.provider, job.destination.folderId)
    let uploadedBytes = selected.filter((f) => f.status === 'done').reduce((sum, f) => sum + (f.size ?? 0), 0)

    const uploadOne = async (file: JobFile) => {
      const { dirs, name } = splitPath(file.path)
      const parentId = await tree.resolve(dirs)
      file.status = 'uploading'
      file.uploaded = 0
      run.touchFiles()
      const base = uploadedBytes
      const stream = file.size === 0 ? Readable.from([]) : fs.createReadStream(diskPathFor(dir, file.path))
      const entry = await dest.upload({
        parentId,
        name: safeName(destAccount.provider, name),
        size: file.size,
        stream,
        signal: run.signal,
        onProgress: (bytes) => {
          file.uploaded = bytes
          run.touchFiles()
          run.set({ uploadedBytes: base + bytes })
        },
      })
      file.status = 'done'
      file.uploaded = file.size ?? 0
      file.remoteId = entry.id
      uploadedBytes += file.size ?? 0
      run.touchFiles()
      run.set({ uploadedBytes })
    }

    const active = torrent
    for (const f of remaining) active.files[f.index].select()
    run.set({ status: 'downloading', note: null, totalBytes: selectedBytes, uploadedBytes })

    const pending = new Set(remaining.map((f) => f.index))
    const queued = new Set<number>()
    let uploads: Promise<void> = Promise.resolve()
    let uploadFailure: unknown
    let lastBytes = -1
    let lastProgressAt = Date.now()

    while (pending.size > 0) {
      run.check()
      if (uploadFailure) throw uploadFailure

      // Hand finished files to the (sequential) upload queue.
      for (const index of pending) {
        if (queued.has(index)) continue
        const tf = active.files[index]
        if (tf.done || tf.length === 0) {
          queued.add(index)
          const file = run.files.find((f) => f.index === index)!
          uploads = uploads
            .then(() => (uploadFailure ? undefined : uploadOne(file)))
            .then(() => {
              pending.delete(index)
            })
            .catch((err) => {
              uploadFailure ??= err
            })
        }
      }

      const downloaded = selected.reduce((sum, f) => {
        const tf = active.files[f.index]
        return sum + (f.status === 'done' || tf.done ? tf.length : Math.min(tf.downloaded, tf.length))
      }, 0)
      const allDownloaded = remaining.every((f) => active.files[f.index].done || active.files[f.index].length === 0)
      run.set({
        status: allDownloaded ? 'uploading' : 'downloading',
        downloadedBytes: downloaded,
        downloadSpeed: allDownloaded ? 0 : Math.round(active.downloadSpeed),
        uploadSpeed: Math.round(active.uploadSpeed),
        peers: active.numPeers,
        note: !allDownloaded && active.numPeers === 0 ? 'Looking for peers…' : null,
      })

      if (downloaded !== lastBytes) {
        lastBytes = downloaded
        lastProgressAt = Date.now()
      } else if (!allDownloaded && Date.now() - lastProgressAt > config.limits.stallTimeoutMs) {
        throw new UserError(`No download progress for ${Math.round(config.limits.stallTimeoutMs / 60_000)} minutes. The torrent may not have enough seeders.`)
      }
      await sleep(1000, run.signal)
    }
    await uploads
    if (uploadFailure) throw uploadFailure

    // Point the user at the top-level folder when everything landed in one.
    const tops = new Set(selected.map((f) => splitPath(f.path).dirs[0]))
    const [top] = tops
    const topEntry = tops.size === 1 && top ? await tree.entry([top]) : undefined
    const folderId = topEntry?.id ?? job.destination.folderId
    const url = topEntry?.url ?? dest.folderUrl(folderId) ?? undefined

    await run.finish('completed', {
      note: null,
      downloadedBytes: selectedBytes,
      uploadedBytes,
      result: { url, folderId },
    })
  } finally {
    releaseDisk(job.id)
    if (torrent && !(torrent as unknown as { destroyed: boolean }).destroyed) {
      const t = torrent
      await new Promise<void>((resolve) => t.destroy({ destroyStore: false }, () => resolve()))
    }
    // Keep partial data only when the worker is restarting and the job will resume here.
    if (!(run.signal.reason instanceof ShutdownError)) await fs.promises.rm(dir, { recursive: true, force: true })
  }
}
