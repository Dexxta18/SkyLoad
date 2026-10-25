import type { Job, JobFile } from '../db/schema.js'
import { log } from '../lib/log.js'
import { finishJob, updateJob, type JobPatch } from './queue.js'

export class ShutdownError extends Error {
  constructor() {
    super('Worker shutting down')
    this.name = 'ShutdownError'
  }
}

/**
 * In-memory state for a running job. Progress is batched and written about once
 * a second; each write doubles as a heartbeat and a check for "cancel" clicks.
 */
export class JobRun {
  readonly controller = new AbortController()
  files: JobFile[]
  private patch: JobPatch = {}
  private filesDirty = false
  private timer?: NodeJS.Timeout
  private flushing?: Promise<void>
  private finished = false

  constructor(public job: Job) {
    this.files = job.files.map((f) => ({ ...f }))
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get log() {
    return log.child({ jobId: this.job.id, kind: this.job.kind })
  }

  start() {
    this.timer = setInterval(() => void this.flush(), 1000)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
  }

  set(patch: JobPatch) {
    Object.assign(this.patch, patch)
  }

  setFiles(files: JobFile[]) {
    this.files = files
    this.filesDirty = true
  }

  touchFiles() {
    this.filesDirty = true
  }

  /** Throws if the job was cancelled or the worker is stopping. */
  check() {
    if (this.signal.aborted) throw this.signal.reason
  }

  /** Stops progress updates and writes the job's final state in one go. */
  async finish(status: Parameters<typeof finishJob>[1], patch: JobPatch = {}) {
    this.stop()
    this.finished = true
    if (this.flushing) await this.flushing
    const final: JobPatch = { ...this.patch, ...(this.filesDirty ? { files: this.files } : {}), ...patch }
    this.patch = {}
    this.filesDirty = false
    await finishJob(this.job.id, status, final)
  }

  get isFinished() {
    return this.finished
  }

  async flush(): Promise<void> {
    if (this.finished) return
    if (this.flushing) return this.flushing
    const patch: JobPatch = { ...this.patch, ...(this.filesDirty ? { files: this.files } : {}) }
    this.patch = {}
    this.filesDirty = false
    this.flushing = updateJob(this.job.id, patch)
      .then(({ cancelRequested }) => {
        if (cancelRequested && !this.signal.aborted) this.controller.abort(new CancelRequested())
      })
      .catch((err) => {
        // Keep the unsaved changes for the next attempt.
        this.patch = { ...patch, ...this.patch }
        if (patch.files) this.filesDirty = true
        this.log.warn({ err }, 'progress update failed')
      })
      .finally(() => {
        this.flushing = undefined
      })
    return this.flushing
  }
}

export class CancelRequested extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelRequested'
  }
}
