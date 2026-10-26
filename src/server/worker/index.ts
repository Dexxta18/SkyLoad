import { config } from '../config.js'
import { CancelledError, sleep, UserError } from '../lib/http.js'
import { log } from '../lib/log.js'
import { claimJob, requeueOwnJobs, requeueStaleJobs } from './queue.js'
import { CancelRequested, JobRun, ShutdownError } from './run.js'
import { closeTorrentClient, runTorrentJob } from './torrent.js'
import { runTransferJob } from './transfer.js'
import { runUrlJob } from './url.js'

const running = new Map<string, { run: JobRun; done: Promise<void> }>()
let stopping = false
let loop: Promise<void> | undefined

function friendlyError(err: unknown): string {
  if (err instanceof UserError) return err.message
  const message = (err as Error)?.message ?? String(err)
  // Provider errors already read reasonably ("Uploading to Google Drive failed (403): ...").
  return message.length > 500 ? message.slice(0, 500) + '…' : message
}

async function execute(run: JobRun) {
  const { job } = run
  run.start()
  run.log.info({ name: job.name, attempt: job.attempts }, 'job started')
  try {
    if (job.kind === 'torrent') await runTorrentJob(run)
    else if (job.kind === 'url') await runUrlJob(run)
    else await runTransferJob(run)
    if (!run.isFinished) await run.finish('completed', { note: null })
    run.log.info('job finished')
  } catch (err) {
    const reason = run.signal.reason
    if (reason instanceof ShutdownError) {
      await run.finish('queued', { note: 'Resuming after a server restart' })
    } else if (reason instanceof CancelRequested || err instanceof CancelRequested || err instanceof CancelledError) {
      await run.finish('cancelled', { note: null })
      run.log.info('job cancelled')
    } else {
      run.log.warn({ err }, 'job failed')
      await run.finish('failed', { error: friendlyError(err), note: null })
    }
  } finally {
    run.stop()
  }
}

async function pollLoop() {
  while (!stopping) {
    try {
      if (running.size < config.worker.concurrency) {
        const job = await claimJob()
        if (job) {
          const run = new JobRun(job)
          const done = execute(run)
            .catch((err) => log.error({ err, jobId: job.id }, 'job bookkeeping failed'))
            .finally(() => running.delete(job.id))
          running.set(job.id, { run, done })
          continue
        }
      }
    } catch (err) {
      log.error({ err }, 'worker poll failed')
    }
    await sleep(config.worker.pollIntervalMs).catch(() => {})
  }
}

export async function startWorker() {
  const resumed = await requeueOwnJobs()
  if (resumed) log.info({ resumed }, 'requeued jobs from a previous run')
  const staleTimer = setInterval(() => {
    requeueStaleJobs()
      .then((n) => n && log.warn({ count: n }, 'requeued jobs from unresponsive workers'))
      .catch((err) => log.error({ err }, 'stale job check failed'))
  }, 60_000)
  staleTimer.unref()
  log.info({ workerId: config.worker.id, concurrency: config.worker.concurrency }, 'worker started')
  loop = pollLoop()
}

/** Stops taking work and hands running jobs back to the queue so they resume after a restart. */
export async function stopWorker() {
  stopping = true
  for (const { run } of running.values()) run.controller.abort(new ShutdownError())
  await Promise.allSettled([...running.values()].map((r) => r.done))
  await loop
  await closeTorrentClient()
}

