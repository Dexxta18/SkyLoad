# Skyload

Download torrents straight to Google Drive, and move files between cloud storage accounts.

Users sign in with Google, paste a magnet link (or drop a `.torrent` file), and Skyload downloads it on the server and uploads it to their Drive. Each file is uploaded as soon as it finishes, while the rest of the torrent is still downloading. The same app copies or moves files and folders between Google Drive, Dropbox, OneDrive, Mega and multiple Google accounts.

## Features

**Torrent → cloud (the main feature)**
- Magnet links and `.torrent` uploads
- Optionally pick which files to download before starting
- Live progress (download %, upload %, speed, peers, ETA) over Server-Sent Events
- Folder structure is kept in the destination; files with odd names are handled
- Checks free space in the destination before downloading, and free disk on the server
- Cancel, retry (already-uploaded files are skipped) and resume after a server restart
- Saves to any connected cloud, not only Drive

**Cloud ↔ cloud**
- Google Drive, Dropbox, OneDrive, Mega, and several accounts per provider
- Copy or move files and whole folders
- Streams from source to destination without writing to disk where possible
- Uses server-side copy when source and destination are the same account
- Google Docs/Sheets/Slides are exported to Office formats

**Multi-user**
- Google sign-in; signing in also connects that Google Drive
- Per-user job limits, queue limits and size limits
- Refresh tokens and Mega sessions are encrypted at rest (AES-256-GCM); Mega passwords are never stored

## Architecture

```
Browser (React + Tailwind)
   │  REST + Server-Sent Events
   ▼
Web (Fastify) ─────────┐
   │                   │  jobs table = queue (FOR UPDATE SKIP LOCKED)
   ▼                   ▼
Postgres ◄──────── Worker(s)
                       │  WebTorrent (TCP/uTP/DHT) ──► peers
                       │  resumable chunked uploads ──► Google Drive / Dropbox / OneDrive / Mega
                       ▼
                   /data/downloads (temporary; deleted after upload)
```

- A single Docker image runs as `ROLE=all` (web and worker together), `ROLE=web`, or `ROLE=worker`. Run more workers to process more jobs at once.
- Uploads use each provider's resumable protocol (Drive resumable sessions, Dropbox upload sessions, OneDrive upload sessions). If a connection drops mid-chunk, the upload resumes from the server's confirmed offset.
- If a worker dies, its jobs go back to the queue after 2 minutes of missed heartbeats.

## Run it locally

```bash
npm install
cp .env.example .env    # optional for local dev
DEV_LOGIN=true LOCAL_PROVIDER_DIR=./data/cloud npm run dev
```

Open http://localhost:5173. `DEV_LOGIN` lets you sign in with any email. `LOCAL_PROVIDER_DIR` adds a pretend cloud backed by a local folder, so you can try the whole flow without Google credentials. Without `DATABASE_URL`, an embedded Postgres (PGlite) is stored in `./data`.

```bash
npm test          # end-to-end torrent + transfer tests, upload protocol tests
npm run typecheck
npm run build && npm start
```

The end-to-end tests run a real BitTorrent tracker and seeder on localhost and download through the real API and worker.

## Setting up the cloud providers

Each provider needs an app registration. Redirect URIs are always `${APP_URL}/api/auth/callback/<provider>`.

### Google (required: sign-in and Drive)
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Configure the **OAuth consent screen** (External), and add the scopes `openid`, `email`, `profile` and either `.../auth/drive` or `.../auth/drive.file`.
3. Under **Credentials**, create an **OAuth client ID** of type *Web application*. Add the redirect URI `https://YOUR_DOMAIN/api/auth/callback/gdrive` (and `http://localhost:5173/api/auth/callback/gdrive` for development).
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

> **About Drive scopes and Google verification.** `GOOGLE_DRIVE_SCOPE=full` (the `drive` scope) lets users browse their whole Drive, which transfers *out of* Drive need. Google classes it as a *restricted* scope: while your app is in testing, up to 100 test users can use it; a public launch needs Google's verification plus a third-party security assessment (CASA). `GOOGLE_DRIVE_SCOPE=file` (`drive.file`) is *non-sensitive* and only needs basic brand verification. Torrent → Drive works fully with it, but Skyload can then only see files and folders it created, so transfers out of Drive are limited to those. Starting with `file` is a sensible way to launch the main feature quickly.

### Dropbox (optional)
Create an app at https://www.dropbox.com/developers/apps with **Full Dropbox** access and the permissions `files.metadata.read`, `files.content.read`, `files.content.write` and `account_info.read`. Add the redirect URI `.../api/auth/callback/dropbox`, then set `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET`.

### OneDrive (optional)
In the Azure portal, open **App registrations → New registration**. Choose "Accounts in any organizational directory and personal Microsoft accounts" and add a *Web* redirect URI `.../api/auth/callback/onedrive`. Add the delegated Microsoft Graph permissions `Files.ReadWrite.All`, `offline_access` and `User.Read`. Create a client secret, then set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.

### Mega (optional, on by default)
Mega needs no setup. Users enter their email and password (and 2FA code) once. Skyload stores only the resulting encrypted session, never the password.

## Deploying

```bash
cp .env.example .env   # set APP_URL, ENCRYPTION_KEY, Google credentials
docker compose up -d --build
```

This starts Postgres and the app on port 3000. Put it behind HTTPS (Caddy, nginx or your host's proxy). Opening port 6881 (TCP and UDP) lets peers connect to you, which makes downloads noticeably faster.

### ⚠️ Where to host the worker

**Check your host's acceptable-use policy before running the torrent worker.** Many app platforms ban BitTorrent traffic outright. **Railway** and **Fly.io** both list torrents as prohibited in their acceptable-use policies, so running the worker there risks having your account suspended. Many VPS providers ban it too.

A setup that works:
- **Web app** (`ROLE=web`) on any platform you like (Railway, Render, Fly, a VPS). It never touches BitTorrent.
- **Worker** (`ROLE=worker`) on a VPS or dedicated server whose terms explicitly allow P2P/BitTorrent traffic. Give it enough disk for your `MAX_TORRENT_SIZE_GB` times `WORKER_CONCURRENCY`.
- Both point at the same managed Postgres through `DATABASE_URL`.

### Running a public service

If you open this to the public you become the operator of a torrent service:
- Publish a real contact address for abuse and DMCA notices, and be ready to act on them. The included `/terms` page is a starting point, not legal advice.
- Keep `MAX_TORRENT_SIZE_GB`, `MAX_ACTIVE_JOBS_PER_USER` and `WORKER_CONCURRENCY` at levels your disk and bandwidth can handle.
- Run the worker on its own machine or network. Magnet links come from users: Skyload strips web seeds, "exact source" URLs and peer hints, drops trackers on private addresses, and blocks private-range peers, but isolating the worker is the real safety net.

## Configuration

All options are environment variables. See [`.env.example`](.env.example) for the full list with comments.

| Variable | Default | |
|---|---|---|
| `APP_URL` | (required in production) | Public URL; used for OAuth redirects |
| `ENCRYPTION_KEY` | (required in production) | 32 bytes, base64 or hex |
| `DATABASE_URL` | embedded PGlite | Postgres connection string |
| `ROLE` | `all` | `all`, `web` or `worker` |
| `GOOGLE_DRIVE_SCOPE` | `full` | `full` or `file` (see above) |
| `WORKER_CONCURRENCY` | `3` | Jobs per worker process |
| `MAX_TORRENT_SIZE_GB` | `50` | Per torrent (after file selection) |
| `MAX_ACTIVE_JOBS_PER_USER` | `2` | Running at the same time |
| `TORRENT_PORT` | `0` (`6881` in Docker) | Incoming peer port |

## Project layout

```
src/server/
  index.ts, app.ts        process entry, Fastify app
  config.ts               all environment configuration
  db/                     Drizzle schema + connection (Postgres or PGlite)
  auth.ts, routes/        sessions, OAuth, REST API, SSE
  providers/              gdrive, dropbox, onedrive, mega (+ local for tests)
  torrent-input.ts        magnet/.torrent parsing and sanitising
  worker/                 queue, torrent runner, transfer runner
src/web/                  React app (Vite + Tailwind)
drizzle/                  SQL migrations (applied automatically on start)
test/                     node:test suites
```
