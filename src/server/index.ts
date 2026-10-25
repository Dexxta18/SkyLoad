import { config } from './config.js'
import { closeDb, initDb } from './db/index.js'
import { log } from './lib/log.js'
import { buildApp } from './app.js'
import { startWorker, stopWorker } from './worker/index.js'

async function main() {
  await initDb()
  const app = config.role === 'worker' ? undefined : await buildApp()
  if (app) {
    await app.listen({ port: config.port, host: config.host })
  }
  if (config.role !== 'web') await startWorker()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'shutting down')
    const force = setTimeout(() => process.exit(1), 25_000)
    force.unref()
    try {
      await app?.close()
      if (config.role !== 'web') await stopWorker()
      await closeDb()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  log.fatal({ err }, 'failed to start')
  process.exit(1)
})
