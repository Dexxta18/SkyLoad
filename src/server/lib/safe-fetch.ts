import dns from 'node:dns'
import type { LookupFunction } from 'node:net'
import type { Readable } from 'node:stream'
import { Agent, request } from 'undici'
import { isPrivateHost } from '../torrent-input.js'
import { UserError } from './http.js'

const BLOCKED = "That link points to a private or internal address, which isn't allowed."

/** Rejects URLs that aren't http(s) or that name a private host or IP literal. */
export function assertAllowedUrl(url: URL, allowPrivate: boolean) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UserError('Only http:// and https:// links are supported.')
  if (url.username || url.password) throw new UserError("Links with a username or password in them aren't supported.")
  if (!allowPrivate && isPrivateHost(url.hostname)) throw new UserError(BLOCKED)
}

type Resolver = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void

/**
 * A DNS lookup for outgoing connections that refuses private addresses. It runs at
 * connect time, so a hostname can't pass a check and then resolve somewhere else
 * (DNS rebinding).
 */
export function makeSafeLookup(allowPrivate: boolean, resolve: Resolver = dns.lookup as unknown as Resolver): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err)
      if (!allowPrivate && addresses.some((a) => isPrivateHost(a.address))) {
        return callback(Object.assign(new UserError(BLOCKED), { code: 'EBLOCKED' }))
      }
      if (options.all) return callback(null, addresses)
      callback(null, addresses[0].address, addresses[0].family)
    })
  }) as LookupFunction
}

const agents = new Map<boolean, Agent>()
function agentFor(allowPrivate: boolean): Agent {
  let agent = agents.get(allowPrivate)
  if (!agent) {
    agent = new Agent({ connect: { lookup: makeSafeLookup(allowPrivate) }, headersTimeout: 30_000, bodyTimeout: 120_000 })
    agents.set(allowPrivate, agent)
  }
  return agent
}

/** File name from a Content-Disposition header, preferring the RFC 5987 `filename*` form. */
export function fileNameFromDisposition(header: string | undefined): string | undefined {
  if (!header) return undefined
  const star = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i)
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = header.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i)
  return plain ? (plain[2] ?? plain[1]).trim() : undefined
}

export function fileNameFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop()
  if (!last) return url.hostname
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

export interface OpenedUrl {
  body: Readable
  /** null when the server doesn't say (chunked responses). */
  size: number | null
  fileName: string
  finalUrl: string
}

/** Opens a download link, following redirects and checking every hop. */
export async function openUrl(url: string, opts: { signal?: AbortSignal; allowPrivate?: boolean; maxRedirects?: number } = {}): Promise<OpenedUrl> {
  const allowPrivate = opts.allowPrivate ?? false
  let current = new URL(url)
  for (let hop = 0; hop <= (opts.maxRedirects ?? 8); hop++) {
    assertAllowedUrl(current, allowPrivate)
    let res: Awaited<ReturnType<typeof request>>
    try {
      res = await request(current, {
        method: 'GET',
        dispatcher: agentFor(allowPrivate),
        signal: opts.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Skyload/1.0)', accept: '*/*', 'accept-encoding': 'identity' },
      })
    } catch (err) {
      if (err instanceof UserError || (err as { cause?: unknown }).cause instanceof UserError) throw err instanceof UserError ? err : (err as { cause: UserError }).cause
      if ((err as NodeJS.ErrnoException).code === 'EBLOCKED') throw new UserError(BLOCKED)
      throw err
    }
    const { statusCode, headers } = res
    if (statusCode >= 300 && statusCode < 400 && headers.location) {
      await res.body.dump()
      current = new URL(String(headers.location), current)
      continue
    }
    if (statusCode >= 400) {
      await res.body.dump()
      throw new UserError(statusCode === 404 ? 'That link returned "not found" (404).' : `That link returned an error (HTTP ${statusCode}).`)
    }
    const type = String(headers['content-type'] ?? '')
    if (/^text\/html/i.test(type)) {
      await res.body.dump()
      throw new UserError("That link opens a web page, not a file. Use a direct download link (it usually ends in the file's name).")
    }
    const length = Number(headers['content-length'])
    return {
      body: res.body,
      size: Number.isFinite(length) && length >= 0 && headers['content-length'] !== undefined ? length : null,
      fileName: fileNameFromDisposition(headers['content-disposition'] as string | undefined) ?? fileNameFromUrl(current),
      finalUrl: current.toString(),
    }
  }
  throw new UserError('That link redirects too many times.')
}
