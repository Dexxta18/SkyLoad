import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { config } from '../config.js'
import * as schema from './schema.js'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

let dbInstance: Db | undefined
let closeFn: (() => Promise<void>) | undefined

function migrationsFolder(): string {
  // Works both from src/ (tsx) and from the bundled dist/server/index.js.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.resolve(here, '../../../drizzle'), path.resolve(here, '../../drizzle'), path.resolve('drizzle')]
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'meta', '_journal.json')))
  if (!found) throw new Error('Could not find the drizzle migrations folder')
  return found
}

/**
 * Connects to Postgres when DATABASE_URL is set; otherwise uses an embedded
 * PGlite database in DATA_DIR (fine for local development and small single-box
 * installs, but web and worker must then run in the same process).
 */
export async function initDb(): Promise<Db> {
  if (dbInstance) return dbInstance
  if (config.databaseUrl) {
    const { default: pg } = await import('pg')
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      ssl: /sslmode=require/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    })
    const db = drizzle(pool, { schema })
    await migrate(db, { migrationsFolder: migrationsFolder() })
    dbInstance = db as unknown as Db
    closeFn = () => pool.end()
  } else {
    if (config.role !== 'all') {
      throw new Error('ROLE=web/worker needs a shared Postgres database: set DATABASE_URL')
    }
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    const client = new PGlite(process.env.PGLITE_MEMORY === '1' ? undefined : path.join(config.dataDir, 'pglite'))
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: migrationsFolder() })
    dbInstance = db as unknown as Db
    closeFn = () => client.close()
  }
  return dbInstance
}

export function db(): Db {
  if (!dbInstance) throw new Error('Database not initialised; call initDb() first')
  return dbInstance
}

export async function closeDb(): Promise<void> {
  await closeFn?.()
  dbInstance = undefined
  closeFn = undefined
}

/** Runs raw SQL and returns rows, papering over driver differences. */
export async function rows<T>(query: SQL): Promise<T[]> {
  const result = (await db().execute(query)) as unknown as { rows: T[] }
  return result.rows
}

export { schema }
