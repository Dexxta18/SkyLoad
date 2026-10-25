import net from 'node:net'
import parseTorrent, { toMagnetURI, toTorrentFile } from 'parse-torrent'
import { config } from './config.js'
import { UserError } from './lib/http.js'

export interface ParsedTorrent {
  infoHash: string
  name?: string
  announce: string[]
  urlList: string[]
  files?: { path: string; length: number }[]
  length?: number
  info?: unknown
  [key: string]: unknown
}

const privateRanges = new net.BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  privateRanges.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [
  ['::1', 128],
  ['::', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  privateRanges.addSubnet(addr, prefix, 'ipv6')

/** True for loopback / private / link-local IP literals and obviously internal names. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !net.isIP(h)) return true
  const type = net.isIP(h)
  if (type === 4) return privateRanges.check(h, 'ipv4')
  if (type === 6) {
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? privateRanges.check(mapped[1], 'ipv4') : privateRanges.check(h, 'ipv6')
  }
  return false
}

/** IPv4 ranges for WebTorrent's peer blocklist, so peers can't be internal hosts. */
export const PRIVATE_PEER_BLOCKLIST = ['0.0.0.0-0.255.255.255', '10.0.0.0-10.255.255.255', '100.64.0.0-100.127.255.255', '127.0.0.0-127.255.255.255', '169.254.0.0-169.254.255.255', '172.16.0.0-172.31.255.255', '192.168.0.0-192.168.255.255']

function allowedTracker(url: string): boolean {
  try {
    const u = new URL(url)
    if (!['http:', 'https:', 'udp:', 'ws:', 'wss:'].includes(u.protocol)) return false
    return config.torrent.allowPrivateTrackers || !isPrivateHost(u.hostname)
  } catch {
    return false
  }
}

/**
 * Strips anything that would make the worker fetch arbitrary URLs: web seeds,
 * "exact source" links, peer hints and trackers on internal addresses.
 */
function sanitize(parsed: ParsedTorrent): ParsedTorrent {
  parsed.announce = (parsed.announce ?? []).filter(allowedTracker).slice(0, 50)
  parsed.urlList = []
  for (const key of ['xs', 'as', 'ws', 'peerAddresses', 'x.pe']) delete parsed[key]
  return parsed
}

const MAGNET_RE = /^magnet:\?/i

export async function parseMagnet(input: string): Promise<{ magnet: string; infoHash: string; name?: string }> {
  const trimmed = input.trim()
  if (!MAGNET_RE.test(trimmed) && !/^[a-f0-9]{40}$/i.test(trimmed)) throw new UserError('That does not look like a magnet link.')
  let parsed: ParsedTorrent
  try {
    parsed = (await parseTorrent(trimmed)) as ParsedTorrent
  } catch {
    throw new UserError('That magnet link is not valid.')
  }
  sanitize(parsed)
  return { magnet: toMagnetURI(parsed), infoHash: parsed.infoHash, name: parsed.name as string | undefined }
}

export async function parseTorrentFile(buffer: Buffer) {
  let parsed: ParsedTorrent
  try {
    parsed = (await parseTorrent(buffer)) as ParsedTorrent
  } catch {
    throw new UserError('That .torrent file could not be read.')
  }
  sanitize(parsed)
  return {
    infoHash: parsed.infoHash,
    name: parsed.name ?? parsed.infoHash,
    files: (parsed.files ?? []).map((f) => ({ path: f.path.split(/[\\/]/).join('/'), length: f.length })),
    length: parsed.length ?? 0,
    torrentFile: Buffer.from(toTorrentFile(parsed)),
  }
}

/** Turns stored job input into something safe to hand to WebTorrent (never a raw string). */
export async function torrentIdFor(source: { magnet?: string; torrentFile?: string | null }): Promise<ParsedTorrent> {
  if (source.torrentFile) return sanitize((await parseTorrent(Buffer.from(source.torrentFile, 'base64'))) as ParsedTorrent)
  if (source.magnet) return sanitize((await parseTorrent(source.magnet)) as ParsedTorrent)
  throw new Error('Job has neither a magnet link nor a torrent file')
}
