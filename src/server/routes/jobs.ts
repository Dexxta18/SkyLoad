import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getAccount } from '../accounts.js'
import { currentUser, requireUser } from '../auth.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { ACTIVE_STATUSES, FINISHED_STATUSES, jobs, type Destination, type Job, type JobFile, type TorrentInput, type TransferInput, type User } from '../db/schema.js'
import { UserError } from '../lib/http.js'
import { parseMagnet, parseTorrentFile } from '../torrent-input.js'

const destinationSchema = z.object({ accountId: z.string().uuid(), folderId: z.string().min(1).max(2000), folderName: z.string().max(1000) })

/** Columns sent to the browser for job lists (no file list, no torrent blob). */
const summaryColumns = {
  id: jobs.id,
  kind: jobs.kind,
  status: jobs.status,
  name: jobs.name,
  destination: jobs.destination,
  totalBytes: jobs.totalBytes,
  downloadedBytes: jobs.downloadedBytes,
  uploadedBytes: jobs.uploadedBytes,
  downloadSpeed: jobs.downloadSpeed,
  uploadSpeed: jobs.uploadSpeed,
  peers: jobs.peers,
  note: jobs.note,
  error: jobs.error,
  result: jobs.result,
  cancelRequested: jobs.cancelRequested,
  createdAt: jobs.createdAt,
  updatedAt: jobs.updatedAt,
  finishedAt: jobs.finishedAt,
  fileCount: sql<number>`jsonb_array_length(${jobs.files})`.mapWith(Number),
  mode: sql<string | null>`${jobs.input}->>'mode'`,
}

function publicJob(job: Job) {
  const { torrentFile: _t, workerId: _w, input, ...rest } = job
  return { ...rest, input: { ...input, magnet: undefined }, fileCount: job.files.length }
}

async function resolveDestination(user: User, dest: Destination | undefined): Promise<Destination> {
  const destination = dest ?? user.settings.defaultDestination
  if (!destination) throw new UserError('Choose where to save files first: connect Google Drive or another cloud on the Accounts page.')
  const account = await getAccount(user.id, destination.accountId)
  if (account.needsReauth) throw new UserError('That storage account needs to be reconnected on the Accounts page.')
  return destination
}

async function checkQueueLimit(userId: string) {
  const [{ count }] = await db()
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), notInArray(jobs.status, FINISHED_STATUSES)))
  if (count >= config.limits.maxQueuedJobsPerUser) throw new UserError(`You can have at most ${config.limits.maxQueuedJobsPerUser} unfinished jobs. Wait for some to finish first.`, 429)
}

async function ownJob(request: FastifyRequest): Promise<Job> {
  const { id } = request.params as { id: string }
  if (!z.string().uuid().safeParse(id).success) throw new UserError('Job not found', 404)
  const [job] = await db()
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, currentUser(request).id)))
  if (!job) throw new UserError('Job not found', 404)
  return job
}

function checkSize(bytes: number) {
  if (bytes > config.limits.maxTorrentBytes) {
    throw new UserError(`That's ${(bytes / 1024 ** 3).toFixed(1)} GB; the limit is ${(config.limits.maxTorrentBytes / 1024 ** 3).toFixed(0)} GB per torrent. Choose fewer files.`)
  }
}

export async function jobRoutes(app: FastifyInstance) {
  app.register(async (authed) => {
    authed.addHook('preHandler', requireUser)

    authed.get('/api/jobs', async (request) => {
      const user = currentUser(request)
      const { kind } = request.query as { kind?: string }
      const where = kind === 'torrent' || kind === 'transfer' ? and(eq(jobs.userId, user.id), eq(jobs.kind, kind)) : eq(jobs.userId, user.id)
      const rows = await db().select(summaryColumns).from(jobs).where(where).orderBy(desc(jobs.createdAt)).limit(100)
      return { jobs: rows }
    })

    authed.get('/api/jobs/:id', async (request) => ({ job: publicJob(await ownJob(request)) }))

    authed.post('/api/jobs/torrent', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
      const user = currentUser(request)
      await checkQueueLimit(user.id)

      let magnetText: string | undefined
      let fileBuffer: Buffer | undefined
      let destination: Destination | undefined
      let chooseFiles = false

      if (request.isMultipart()) {
        for await (const part of request.parts({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } })) {
          if (part.type === 'file') {
            fileBuffer = await part.toBuffer()
          } else if (part.fieldname === 'magnet') magnetText = String(part.value)
          else if (part.fieldname === 'destination' && part.value) destination = destinationSchema.parse(JSON.parse(String(part.value)))
          else if (part.fieldname === 'chooseFiles') chooseFiles = String(part.value) === 'true'
        }
      } else {
        const body = z.object({ magnet: z.string().min(1).max(20_000), destination: destinationSchema.optional(), chooseFiles: z.boolean().optional() }).parse(request.body)
        magnetText = body.magnet
        destination = body.destination
        chooseFiles = body.chooseFiles ?? false
      }
      const dest = await resolveDestination(user, destination)

      let values: typeof jobs.$inferInsert
      if (fileBuffer) {
        const parsed = await parseTorrentFile(fileBuffer)
        if (!chooseFiles) checkSize(parsed.length)
        const files: JobFile[] = parsed.files.map((f, index) => ({ index, path: f.path, size: f.length, selected: true, status: 'pending', uploaded: 0 }))
        const input: TorrentInput = { infoHash: parsed.infoHash, chooseFiles, selectionMade: !chooseFiles }
        values = {
          userId: user.id,
          kind: 'torrent',
          name: parsed.name,
          input,
          torrentFile: parsed.torrentFile.toString('base64'),
          destination: dest,
          files,
          totalBytes: parsed.length,
          // The file list is already known, so selection doesn't need a worker.
          status: chooseFiles ? 'awaiting_selection' : 'queued',
        }
      } else if (magnetText) {
        const parsed = await parseMagnet(magnetText)
        const input: TorrentInput = { magnet: parsed.magnet, infoHash: parsed.infoHash, chooseFiles, selectionMade: !chooseFiles }
        values = { userId: user.id, kind: 'torrent', name: parsed.name ?? parsed.infoHash, input, destination: dest, status: 'queued' }
      } else {
        throw new UserError('Paste a magnet link or choose a .torrent file.')
      }

      const infoHash = (values.input as TorrentInput).infoHash
      const [duplicate] = await db()
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.userId, user.id), eq(jobs.kind, 'torrent'), notInArray(jobs.status, FINISHED_STATUSES), sql`${jobs.input}->>'infoHash' = ${infoHash}`))
      if (duplicate) throw new UserError('That torrent is already in your queue.', 409)

      const [job] = await db().insert(jobs).values(values).returning()
      return { job: publicJob(job) }
    })

    authed.post('/api/jobs/transfer', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
      const user = currentUser(request)
      await checkQueueLimit(user.id)
      const body = z
        .object({
          sourceAccountId: z.string().uuid(),
          items: z
            .array(z.object({ id: z.string().min(1).max(2000), name: z.string().min(1).max(1000), isFolder: z.boolean(), size: z.number().nullable().optional() }))
            .min(1)
            .max(500),
          destination: destinationSchema,
          mode: z.enum(['copy', 'move']),
        })
        .parse(request.body)
      await getAccount(user.id, body.sourceAccountId)
      const dest = await resolveDestination(user, body.destination)
      if (body.sourceAccountId === dest.accountId && body.items.some((i) => i.isFolder && i.id === dest.folderId)) {
        throw new UserError("A folder can't be copied into itself.")
      }
      const input: TransferInput = { sourceAccountId: body.sourceAccountId, items: body.items, mode: body.mode }
      const name = body.items.length === 1 ? body.items[0].name : `${body.items[0].name} and ${body.items.length - 1} more`
      const [job] = await db().insert(jobs).values({ userId: user.id, kind: 'transfer', name, input, destination: dest, status: 'queued' }).returning()
      return { job: publicJob(job) }
    })

    authed.post('/api/jobs/:id/select', async (request) => {
      const job = await ownJob(request)
      if (job.status !== 'awaiting_selection') throw new UserError('This download is not waiting for file selection.', 409)
      const { fileIndexes } = z.object({ fileIndexes: z.array(z.number().int().min(0)).min(1) }).parse(request.body)
      const chosen = new Set(fileIndexes)
      const files = job.files.map((f) => ({ ...f, selected: chosen.has(f.index) }))
      if (!files.some((f) => f.selected)) throw new UserError('Pick at least one file.')
      const totalBytes = files.filter((f) => f.selected).reduce((sum, f) => sum + (f.size ?? 0), 0)
      checkSize(totalBytes)
      const [updated] = await db()
        .update(jobs)
        .set({ files, totalBytes, status: 'queued', note: null, input: { ...(job.input as TorrentInput), selectionMade: true } })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'awaiting_selection')))
        .returning()
      return { job: publicJob(updated) }
    })

    authed.post('/api/jobs/:id/cancel', async (request) => {
      const job = await ownJob(request)
      if (FINISHED_STATUSES.includes(job.status)) return { job: publicJob(job) }
      // Jobs nobody is working on can be cancelled right away; running ones are
      // flagged and the worker stops them within a second or two.
      const [direct] = await db()
        .update(jobs)
        .set({ status: 'cancelled', finishedAt: new Date(), note: null })
        .where(and(eq(jobs.id, job.id), inArray(jobs.status, ['queued', 'awaiting_selection'])))
        .returning()
      if (direct) return { job: publicJob(direct) }
      const [flagged] = await db().update(jobs).set({ cancelRequested: true, note: 'Cancelling…' }).where(eq(jobs.id, job.id)).returning()
      return { job: publicJob(flagged) }
    })

    authed.post('/api/jobs/:id/retry', async (request) => {
      const job = await ownJob(request)
      if (job.status !== 'failed' && job.status !== 'cancelled') throw new UserError('Only failed or cancelled jobs can be retried.', 409)
      await checkQueueLimit(job.userId)
      const torrentInput = job.kind === 'torrent' ? (job.input as TorrentInput) : undefined
      const needsSelection = torrentInput?.chooseFiles && !torrentInput.selectionMade
      const [updated] = await db()
        .update(jobs)
        .set({
          status: needsSelection && job.files.length ? 'awaiting_selection' : 'queued',
          error: null,
          note: null,
          cancelRequested: false,
          notBefore: null,
          workerId: null,
          finishedAt: null,
          downloadSpeed: 0,
          uploadSpeed: 0,
          peers: 0,
          // Files that already reached the cloud are skipped on retry.
          files: job.files.map((f) => (f.status === 'done' ? f : { ...f, status: 'pending' as const, uploaded: 0, error: undefined })),
        })
        .where(eq(jobs.id, job.id))
        .returning()
      return { job: publicJob(updated) }
    })

    authed.delete('/api/jobs/:id', async (request) => {
      const job = await ownJob(request)
      if (ACTIVE_STATUSES.includes(job.status)) throw new UserError('Cancel this job before removing it.', 409)
      await db().delete(jobs).where(eq(jobs.id, job.id))
      return { ok: true }
    })

    authed.delete('/api/jobs', async (request) => {
      const user = currentUser(request)
      const { kind } = request.query as { kind?: string }
      const conditions = [eq(jobs.userId, user.id), inArray(jobs.status, FINISHED_STATUSES)]
      if (kind === 'torrent' || kind === 'transfer') conditions.push(eq(jobs.kind, kind))
      await db()
        .delete(jobs)
        .where(and(...conditions))
      return { ok: true }
    })

    // Live job updates over Server-Sent Events. Workers may run in another process,
    // so this polls the database rather than listening to in-memory events.
    authed.get('/api/events', async (request, reply) => {
      const user = currentUser(request)
      reply.hijack()
      const res = reply.raw
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      const sent = new Map<string, string>()
      let closed = false
      let ticks = 0
      const tick = async () => {
        if (closed) return
        try {
          // A rolling window on the database clock, so app/DB clock skew doesn't matter
          // and rows committed slightly late are still picked up. Duplicates are skipped.
          const changed = await db()
            .select(summaryColumns)
            .from(jobs)
            .where(and(eq(jobs.userId, user.id), gt(jobs.updatedAt, sql`now() - interval '5 seconds'`)))
          for (const job of changed) {
            const stamp = job.updatedAt.toISOString()
            if (sent.get(job.id) === stamp) continue
            sent.set(job.id, stamp)
            res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`)
          }
          if (++ticks % 15 === 0) res.write(': ping\n\n')
        } catch (err) {
          request.log.warn({ err }, 'event stream poll failed')
        }
        if (!closed) setTimeout(tick, 1000)
      }
      request.raw.on('close', () => {
        closed = true
      })
      void tick()
    })
  })
}
