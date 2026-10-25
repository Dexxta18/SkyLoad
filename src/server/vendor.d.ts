// Minimal typings for untyped dependencies.
declare module 'parse-torrent' {
  const parseTorrent: (id: unknown) => Promise<Record<string, any>>
  export default parseTorrent
  export function toMagnetURI(parsed: object): string
  export function toTorrentFile(parsed: object): Uint8Array
}

declare module 'bittorrent-tracker' {
  export class Server {
    constructor(opts?: Record<string, unknown>)
    http: import('node:http').Server
    listen(port: number, hostname: string, cb: () => void): void
    close(cb?: () => void): void
  }
}

declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events'

  export interface TorrentFile {
    name: string
    path: string
    length: number
    downloaded: number
    progress: number
    done: boolean
    select(priority?: number): void
    deselect(): void
  }

  export interface Torrent extends EventEmitter {
    infoHash: string
    name: string
    files: TorrentFile[]
    length: number
    downloaded: number
    downloadSpeed: number
    uploadSpeed: number
    numPeers: number
    progress: number
    timeRemaining: number
    ready: boolean
    done: boolean
    torrentFile: Uint8Array
    path: string
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void
    select(start: number, end: number, priority?: number): void
    deselect(start: number, end: number): void
  }

  export interface ClientOptions {
    dht?: boolean | object
    lsd?: boolean
    utp?: boolean
    natUpnp?: boolean
    natPmp?: boolean
    webSeeds?: boolean
    tracker?: boolean | object
    torrentPort?: number
    dhtPort?: number
    blocklist?: string[] | string
    downloadLimit?: number
    uploadLimit?: number
    maxConns?: number
  }

  export interface AddOptions {
    path?: string
    deselect?: boolean
    announce?: string[]
    destroyStoreOnDestroy?: boolean
    skipVerify?: boolean
    strategy?: 'sequential' | 'rarest'
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: ClientOptions)
    torrents: Torrent[]
    add(torrentId: unknown, opts?: AddOptions, onTorrent?: (torrent: Torrent) => void): Torrent
    seed(input: unknown, opts?: Record<string, unknown>, onSeed?: (torrent: Torrent) => void): Torrent
    get(torrentId: unknown): Promise<Torrent | null>
    destroy(cb?: (err?: Error) => void): void
  }
}

declare module 'filename-reserved-regex' {
  export default function filenameReservedRegex(): RegExp
}
