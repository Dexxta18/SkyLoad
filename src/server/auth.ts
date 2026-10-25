import type { FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, gt } from 'drizzle-orm'
import { config } from './config.js'
import { db } from './db/index.js'
import { sessions, users, type User } from './db/schema.js'
import { randomToken, sha256 } from './lib/crypto.js'
import { UserError } from './lib/http.js'

export const SESSION_COOKIE = 'sl_session'
const SESSION_DAYS = 30

declare module 'fastify' {
  interface FastifyRequest {
    user?: User
  }
}

export const secureCookies = config.appUrl.startsWith('https://')

export async function startSession(reply: FastifyReply, userId: string) {
  const token = randomToken()
  await db()
    .insert(sessions)
    .values({ id: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    maxAge: SESSION_DAYS * 86_400,
  })
}

export async function endSession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[SESSION_COOKIE]
  if (token) await db().delete(sessions).where(eq(sessions.id, sha256(token)))
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

export async function loadUser(request: FastifyRequest): Promise<User | undefined> {
  if (request.user) return request.user
  const token = request.cookies[SESSION_COOKIE]
  if (!token) return undefined
  const [row] = await db()
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
  request.user = row?.user
  return request.user
}

/** preHandler that rejects anonymous requests. */
export async function requireUser(request: FastifyRequest) {
  const user = await loadUser(request)
  if (!user) throw new UserError('Please sign in', 401)
}

export function currentUser(request: FastifyRequest): User {
  if (!request.user) throw new UserError('Please sign in', 401)
  return request.user
}

/** Finds the user for a Google identity, creating it on first sign-in. */
export async function upsertGoogleUser(profile: { sub: string; email: string; name?: string; avatarUrl?: string }): Promise<User> {
  const [bySub] = await db().select().from(users).where(eq(users.googleSub, profile.sub))
  const [byEmail] = bySub ? [bySub] : await db().select().from(users).where(eq(users.email, profile.email.toLowerCase()))
  const values = { email: profile.email.toLowerCase(), name: profile.name ?? null, avatarUrl: profile.avatarUrl ?? null, googleSub: profile.sub }
  if (byEmail) {
    const [updated] = await db().update(users).set(values).where(eq(users.id, byEmail.id)).returning()
    return updated
  }
  const [created] = await db().insert(users).values(values).returning()
  return created
}
