import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db, rows } from '../db/index.js'
import { ACTIVE_STATUSES, jobs, type Job, type JobStatus } from '../db/schema.js'

/**
 * Atomically claims the oldest runnable job. SKIP LOCKED lets several workers
 * poll the same table without stepping on each other; the per-user check keeps
 * one person from filling every slot.
 */
export async function claimJob(): Promise<Job | undefined> {
  const active = sql.join(
    ACTIVE_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )
  const [row] = await rows<{ id: string }>(sql`
    UPDATE jobs SET
      status = 'starting',
      worker_id = ${config.worker.id},
      heartbeat_at = now(),
      started_at = coalesce(started_at, now()),
      attempts = attempts + 1,
      note = NULL,
      updated_at = now()
    WHERE id = (
      SELECT j.id FROM jobs j
      WHERE j.status = 'queued'
        AND (j.not_before IS NULL OR j.not_before <= now())
        AND (
          SELECT count(*) FROM jobs a
          WHERE a.user_id = j.user_id AND a.status IN (${active})
        ) < ${config.limits.maxActiveJobsPerUser}
      ORDER BY j.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id
  `)
  if (!row) return undefined
  const [job] = await db().select().from(jobs).where(eq(jobs.id, row.id))
  return job
}

/** Puts jobs whose worker vanished (crash, redeploy) back in the queue. */
export async function requeueStaleJobs(): Promise<number> {
  const stale = await db()
    .update(jobs)
    .set({ status: 'queued', workerId: null, note: 'Resuming after a server restart', downloadSpeed: 0, uploadSpeed: 0, peers: 0 })
    .where(and(inArray(jobs.status, ACTIVE_STATUSES), lt(jobs.heartbeatAt, sql`now() - interval '2 minutes'`)))
    .returning({ id: jobs.id })
  return stale.length
}

/** On startup, anything this worker id owned is from a previous run. */
export async function requeueOwnJobs(): Promise<number> {
  const mine = await db()
    .update(jobs)
    .set({ status: 'queued', workerId: null, note: 'Resuming after a server restart', downloadSpeed: 0, uploadSpeed: 0, peers: 0 })
    .where(and(inArray(jobs.status, ACTIVE_STATUSES), eq(jobs.workerId, config.worker.id)))
    .returning({ id: jobs.id })
  return mine.length
}

export type JobPatch = Partial<Omit<typeof jobs.$inferInsert, 'id' | 'userId'>>

/** Writes progress and returns whether the user asked to cancel. */
export async function updateJob(id: string, patch: JobPatch): Promise<{ cancelRequested: boolean }> {
  const [row] = await db()
    .update(jobs)
    .set({ ...patch, heartbeatAt: sql`now()` })
    .where(eq(jobs.id, id))
    .returning({ cancelRequested: jobs.cancelRequested })
  // A deleted job counts as cancelled.
  return { cancelRequested: row?.cancelRequested ?? true }
}

export async function finishJob(id: string, status: Extract<JobStatus, 'completed' | 'failed' | 'cancelled' | 'awaiting_selection' | 'queued'>, patch: JobPatch = {}) {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
  await db()
    .update(jobs)
    .set({
      downloadSpeed: 0,
      uploadSpeed: 0,
      peers: 0,
      ...patch,
      status,
      workerId: null,
      ...(terminal ? { finishedAt: new Date(), cancelRequested: false } : {}),
    })
    .where(eq(jobs.id, id))
}
