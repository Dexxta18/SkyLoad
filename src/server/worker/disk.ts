import fs from 'node:fs'
import { config } from '../config.js'

/** Bytes promised to running downloads on this worker, so two jobs can't both count the same free space. */
const reserved = new Map<string, number>()

export async function diskStats() {
  const s = await fs.promises.statfs(config.downloadsDir)
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
}

export async function reserveDisk(jobId: string, bytes: number): Promise<'ok' | 'wait' | 'too-big'> {
  const { free, total } = await diskStats()
  if (bytes + config.limits.minFreeDiskBytes > total) return 'too-big'
  let others = 0
  for (const [id, n] of reserved) if (id !== jobId) others += n
  if (free - others - config.limits.minFreeDiskBytes < bytes) return 'wait'
  reserved.set(jobId, bytes)
  return 'ok'
}

export function releaseDisk(jobId: string) {
  reserved.delete(jobId)
}
