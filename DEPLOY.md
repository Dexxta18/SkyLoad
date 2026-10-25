# Putting Skyload online

This guide gets Skyload running at your own web address, for example `https://skyload.yourdomain.com`. It takes about an hour, most of it waiting for things to activate.

You will need:

| What | Why | Rough cost |
|---|---|---|
| A Linux server (VPS) that **allows BitTorrent** | Runs the app and does the downloading | $5–20 / month |
| A domain name | Google sign-in and HTTPS need one | ~$10 / year |
| A Google Cloud project | "Continue with Google" and Drive access | Free |

Everything below can be done from a laptop. Steps 1–3 also work from a phone; step 4 needs an SSH app (for example Termius).

---

## 1. Get a server

**Requirements:** Ubuntu 24.04 (or Debian 12), at least 2 CPU cores, 4 GB RAM, and as much disk as the largest torrents you want to allow (100 GB or more is a good start). Prefer plans with generous or unmetered bandwidth, since every download comes in and then goes out again to Google.

**The host must allow torrenting.** Many don't, and they suspend accounts that do it:

- **Railway** and **Fly.io** forbid torrents in their acceptable-use policies. Don't run Skyload there.
- **VPSDime** bans BitTorrent clients.
- Some hosts do allow legal torrenting. [Host-C's torrenting policy](https://my.host-c.com/knowledgebase/2/Torrenting-Policy.html) permits it for legally distributable content. BuyVM is reported to allow it within fair-use bandwidth limits. Policies change, so **before you pay, ask the host's support in writing**: *"Can I run a BitTorrent client for legal content on your VPS?"*

When the server is ready, note its **IP address** and **root password** (or SSH key).

## 2. Point a domain at the server

1. Buy a domain from any registrar (Cloudflare, Porkbun, Namecheap and others), or use one you already own.
2. In the domain's DNS settings, add an **A record**:
   - Name: `skyload` (this gives you `skyload.yourdomain.com`; use `@` for the bare domain)
   - Value: your server's IP address
   - If you use Cloudflare, set the record to **DNS only** (grey cloud).
3. It can take from a few minutes to an hour to take effect.

From here on, `YOUR_DOMAIN` means the full name, for example `skyload.yourdomain.com`.

## 3. Create the Google sign-in credentials

1. Go to https://console.cloud.google.com/ and create a project called **Skyload** (project picker at the top → *New project*).
2. Enable Drive: *APIs & Services → Library*, search **Google Drive API**, click **Enable**.
3. Set up the consent screen. Open *Google Auth Platform* (in older layouts it's *APIs & Services → OAuth consent screen*) and click **Get started**:
   - App name: `Skyload`. Support email: your email.
   - Audience: **External**.
   - Contact email: your email. Accept the policy and click **Create**.
4. *Data access* → **Add or remove scopes** and tick:
   - `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid`
   - `.../auth/drive` (to let users browse their whole Drive) **or** `.../auth/drive.file` (see [Which Drive access?](#which-drive-access) below)
   - Click **Update**, then **Save**.
5. *Audience* → **Test users** → **Add users**: add your own Gmail address and anyone else who should be able to sign in while you're testing (up to 100).
6. *Clients* → **Create client**:
   - Application type: **Web application**, name `Skyload`.
   - **Authorized redirect URIs** → Add URI: `https://YOUR_DOMAIN/api/auth/callback/gdrive`
   - Click **Create** and copy the **Client ID** and **Client secret**.

## 4. Install Skyload on the server

Connect to the server (replace the IP):

```bash
ssh root@203.0.113.10
```

Download the code. The repository is private, so GitHub asks for a username and password. Use your GitHub username, and as the password a **personal access token**: GitHub → Settings → Developer settings → Personal access tokens → *Fine-grained tokens* → **Generate new token**, *Only select repositories: SkyLoad*, *Repository permissions → Contents: Read-only*.

```bash
apt-get update && apt-get install -y git
git clone https://github.com/Dexxta18/SkyLoad.git skyload
cd skyload
./deploy/install.sh
```

The installer:
- asks for your domain, the Google client ID and secret, which Drive access to use, and the largest torrent to allow
- installs Docker, generates secret keys, and opens the firewall ports
- builds and starts the app (the first build takes 5–10 minutes)

When it prints **Skyload is running**, open `https://YOUR_DOMAIN`. The HTTPS certificate is issued automatically on the first visit, which can take up to a minute.

## 5. Try it

1. Click **Continue with Google** and sign in with an account you added as a test user. Google warns that the app isn't verified; click *Continue*. That's expected while you're testing.
2. Paste a magnet link for something legal and well seeded, such as an Ubuntu release from https://ubuntu.com/download/alternative-downloads (use the "BitTorrent" links).
3. Watch it download, then open it in your Drive.

## Everyday commands

Run these on the server, inside the `skyload` folder:

| Task | Command |
|---|---|
| See what's happening | `docker compose logs -f app` |
| Update to the latest code | `git pull && docker compose up -d --build` |
| Change a setting | edit `.env` (`nano .env`), then `docker compose up -d` |
| Restart | `docker compose restart app` |
| Stop everything | `docker compose down` |
| Back up the database | `docker compose exec db pg_dump -U skyload skyload > backup.sql` |

Keep a copy of `.env` somewhere safe. If `ENCRYPTION_KEY` is lost, everyone has to reconnect their cloud accounts.

## Troubleshooting

| You see | Fix |
|---|---|
| Google: **Error 400: redirect_uri_mismatch** | The redirect URI in step 3.6 must be exactly `https://YOUR_DOMAIN/api/auth/callback/gdrive` |
| Google: **Access blocked / app not verified / not a test user** | Add that Gmail address under *Audience → Test users* |
| Browser: certificate or "can't connect" errors | DNS isn't pointing at the server yet (step 2), or ports 80/443 are blocked by the host's firewall |
| Torrent stuck on "Finding peers" | The torrent has no seeders, or the host blocks BitTorrent traffic. Try a popular torrent first |
| Build fails with "killed" or out of memory | The server needs more RAM, or rerun `./deploy/install.sh` (it adds swap on small servers) |

## Opening it to the public

While the Google project is in *Testing*, only your test users (up to 100) can sign in. To let anyone sign in:

<a id="which-drive-access"></a>
**Which Drive access?**
- `full` (the `drive` scope) lets people browse and transfer *anything* in their Drive. Google classes it as *restricted*: publishing needs Google's verification **plus a paid third-party security assessment (CASA)**.
- `file` (the `drive.file` scope) only lets Skyload see files and folders it created. Torrent downloads to Drive work fully; transfers *out of* Drive only see Skyload's own folders. It's *non-sensitive*, so publishing needs only basic brand verification (a homepage, a privacy policy link and domain ownership).

The quickest way to a public launch is to set `GOOGLE_DRIVE_SCOPE=file` in `.env` (and pick `drive.file` in step 3.4), then click **Publish app** under *Audience*.

Also, before inviting the public:
- Put a real contact email on the Terms page (`src/web/pages/Terms.tsx`) for abuse and copyright (DMCA) reports, and act on them.
- Keep `MAX_TORRENT_SIZE_GB`, `MAX_ACTIVE_JOBS_PER_USER` and `WORKER_CONCURRENCY` within what your disk and bandwidth can handle.

## Adding Dropbox, OneDrive and Mega

Mega works out of the box. For Dropbox and OneDrive, create an app with each provider (see [README → Setting up the cloud providers](README.md#setting-up-the-cloud-providers)), using these redirect URIs:

- `https://YOUR_DOMAIN/api/auth/callback/dropbox`
- `https://YOUR_DOMAIN/api/auth/callback/onedrive`

Put the keys in `.env` and run `docker compose up -d`.
