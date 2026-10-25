import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyError } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { ZodError } from 'zod'
import { config } from './config.js'
import { cookieSecret } from './lib/crypto.js'
import { HttpError, UserError } from './lib/http.js'
import { log } from './lib/log.js'
import { enabledProviders } from './providers/index.js'
import { accountRoutes } from './routes/accounts.js'
import { authRoutes } from './routes/auth.js'
import { jobRoutes } from './routes/jobs.js'

function webRoot(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return [path.resolve(here, '../web'), path.resolve(here, '../../dist/web'), path.resolve('dist/web')].find((dir) => fs.existsSync(path.join(dir, 'index.html')))
}

export async function buildApp() {
  const app = Fastify({ loggerInstance: log, trustProxy: config.trustProxy, bodyLimit: 1024 * 1024 })

  await app.register(cookie, { secret: cookieSecret })
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } })
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: (req) => req.url === '/api/events' })

  // Cookie auth + JSON bodies: reject cross-site form posts as a CSRF guard.
  app.addHook('onRequest', async (request) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !request.url.startsWith('/api/')) return
    const origin = request.headers.origin
    if (origin && origin !== config.appUrl && new URL(origin).host !== request.headers.host) {
      throw new UserError('Cross-site request blocked', 403)
    }
  })

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof UserError) return reply.status(err.status).send({ error: err.message })
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') })
    if (err instanceof HttpError) {
      request.log.warn({ err }, 'upstream API error')
      return reply.status(502).send({ error: err.message })
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message })
    request.log.error({ err }, 'request failed')
    return reply.status(500).send({ error: 'Something went wrong on our side. Please try again.' })
  })

  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/config', async () => ({
    providers: enabledProviders(),
    devLogin: config.devLogin,
    googleLogin: Boolean(config.google.clientId),
    driveScope: config.google.driveScope,
    limits: { maxTorrentBytes: config.limits.maxTorrentBytes, maxActiveJobsPerUser: config.limits.maxActiveJobsPerUser },
  }))

  await app.register(authRoutes)
  await app.register(accountRoutes)
  await app.register(jobRoutes)

  const root = webRoot()
  if (root) {
    await app.register(fastifyStatic, { root, wildcard: false, maxAge: '1h', setHeaders: (reply, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      } })
    // Client-side routes all serve the SPA shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' })
      return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html')
    })
  } else {
    app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'Not found' }))
  }

  return app
}
