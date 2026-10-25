import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { clientFor, getAccount } from '../accounts.js'
import { config } from '../config.js'
import type { JobFile, TransferInput } from '../db/schema.js'
import { CancelledError, isRetryable, sleep, UserError } from '../lib/http.js'
import type { CloudClient } from '../providers/types.js'
import type { JobRun } from './run.js'
import { FolderTree, safeName, splitPath } from './uploader.js'

const MAX_FILES = 20_000

/** Lists every file under the selected items, keeping their relative paths. */
async function expand(source: CloudClient, items: TransferInput['items'], run: JobRun): Promise<JobFile[]> {
  const files: JobFile[] = []
  const walk = async (folderId: string, prefix: string) => {
    for (const entry of await source.list(folderId)) {
      run.check()
      const rel = `${prefix}/${entry.name}`
      if (entry.isFolder) await walk(entry.id, rel)
      else files.push({ index: files.length, path: rel, size: entry.size, selected: true, status: 'pending', uploaded: 0, sourceId: entry.id })
      if (files.length > MAX_FILES) throw new UserError(`That's more than ${MAX_FILES.toLocaleString()} files. Transfer smaller folders.`)
    }
    run.set({ note: `Scanning… ${files.length.toLocaleString()} files found` })
  }
  for (const item of items) {
    if (item.isFolder) await walk(item.id, item.name)
    else files.push({ index: files.length, path: item.name, size: item.size ?? null, selected: true, status: 'pending', uploaded: 0, sourceId: item.id })
  }
  return files
}

/** Copies (or moves) files between two connected accounts, streaming without touching disk where possible. */
export async function runTransferJob(run: JobRun): Promise<void> {
  const { job } = run
  const input = job.input as TransferInput
  const sourceAccount = await getAccount(job.userId, input.sourceAccountId)
  const destAccount = await getAccount(job.userId, job.destination.accountId)
  const source = clientFor(sourceAccount)
  const dest = clientFor(destAccount)
  const sameAccount = sourceAccount.id === destAccount.id

  run.set({ status: 'transferring', note: 'Scanning files…' })
  await run.flush()

  if (!run.files.length) {
    const files = await expand(source, input.items, run)
    if (!files.length) throw new UserError('There are no files to transfer in that selection.')
    run.setFiles(files)
    run.set({ totalBytes: files.reduce((sum, f) => sum + (f.size ?? 0), 0) })
  }

  const tree = new FolderTree(dest, destAccount.provider, job.destination.folderId)
  let doneBytes = run.files.filter((f) => f.status === 'done').reduce((sum, f) => sum + (f.size ?? 0), 0)
  run.set({ note: null, uploadedBytes: doneBytes, downloadedBytes: doneBytes })

  let lastTick = Date.now()
  let bytesSinceTick = 0
  const speed = (n: number) => {
    bytesSinceTick += n
    const now = Date.now()
    if (now - lastTick >= 1000) {
      run.set({ uploadSpeed: Math.round((bytesSinceTick * 1000) / (now - lastTick)) })
      lastTick = now
      bytesSinceTick = 0
    }
  }

  const failures: string[] = []
  for (const file of run.files) {
    if (file.status === 'done') continue
    run.check()
    const { dirs, name } = splitPath(file.path)
    file.status = 'uploading'
    file.uploaded = 0
    run.touchFiles()
    try {
      const parentId = await tree.resolve(dirs)
      let entryId: string
      if (sameAccount && source.copy) {
        entryId = (await source.copy(file.sourceId!, parentId, name)).id
      } else {
        entryId = await streamFile(source, dest, file, parentId, destAccount.provider, run, (bytes, delta) => {
          file.uploaded = bytes
          run.touchFiles()
          run.set({ uploadedBytes: doneBytes + bytes, downloadedBytes: doneBytes + bytes })
          speed(delta)
        })
      }
      file.status = 'done'
      file.remoteId = entryId
      file.uploaded = file.size ?? file.uploaded
      file.error = undefined
      doneBytes += file.size ?? file.uploaded
      run.set({ uploadedBytes: doneBytes, downloadedBytes: doneBytes })
    } catch (err) {
      if (run.signal.aborted || err instanceof CancelledError) throw run.signal.reason ?? err
      // One bad file shouldn't sink the whole transfer; report it at the end.
      file.status = 'failed'
      file.error = (err as Error).message
      failures.push(`${file.path}: ${file.error}`)
      run.log.warn({ err, file: file.path }, 'file transfer failed')
      if (!isRetryable(err) && /401|403/.test(String((err as Error).message)) && failures.length >= 3) break
    }
    run.touchFiles()
  }

  if (failures.length) {
    throw new UserError(`${failures.length} of ${run.files.length} files failed. First error: ${failures[0]}. Retry to try the failed files again.`)
  }

  if (input.mode === 'move') {
    run.set({ note: 'Removing originals…' })
    for (const item of input.items) await source.delete(item.id)
  }

  const [single] = input.items
  const topEntry = input.items.length === 1 && single.isFolder ? await tree.entry([single.name]) : undefined
  const folderId = topEntry?.id ?? job.destination.folderId
  await run.finish('completed', {
    note: null,
    uploadSpeed: 0,
    result: { folderId, url: topEntry?.url ?? dest.folderUrl(folderId) ?? undefined },
  })
}

async function streamFile(
  source: CloudClient,
  dest: CloudClient,
  file: JobFile,
  parentId: string,
  provider: Parameters<typeof safeName>[0],
  run: JobRun,
  onBytes: (total: number, delta: number) => void,
): Promise<string> {
  const { name } = splitPath(file.path)
  for (let attempt = 0; ; attempt++) {
    let spooled: string | undefined
    try {
      const download = await source.download(file.sourceId!, run.signal)
      let { stream, size } = download
      // Some destinations need the size before the first byte; buffer to disk if the source can't say.
      if (size === null) {
        spooled = path.join(config.tmpDir, `${run.job.id}-${file.index}`)
        await pipeline(stream, fs.createWriteStream(spooled), { signal: run.signal })
        size = (await fs.promises.stat(spooled)).size
        stream = fs.createReadStream(spooled)
        file.size = size
      }
      let last = 0
      const entry = await dest.upload({
        parentId,
        name: safeName(provider, download.name ?? name),
        size,
        stream,
        signal: run.signal,
        onProgress: (bytes) => {
          onBytes(bytes, bytes - last)
          last = bytes
        },
      })
      return entry.id
    } catch (err) {
      // Streams can't be rewound, so a broken connection restarts this file from the top.
      if (attempt >= 2 || !isRetryable(err) || run.signal.aborted) throw err
      await sleep(2000 * (attempt + 1), run.signal)
    } finally {
      if (spooled) await fs.promises.rm(spooled, { force: true })
    }
  }
}
