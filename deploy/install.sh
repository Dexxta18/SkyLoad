#!/usr/bin/env bash
# One-command setup for Skyload on a fresh Ubuntu or Debian server.
#
#   git clone https://github.com/Dexxta18/SkyLoad.git skyload
#   cd skyload
#   sudo ./deploy/install.sh
#
# It installs Docker if needed, asks for your domain and Google credentials,
# writes .env with fresh secrets, opens the firewall and starts everything.
# Safe to run again: an existing .env is kept.
#
# Answers can be given up front instead of typed, for example:
#   sudo DOMAIN=skyload.example.com TORRENT_UPLOAD_LIMIT_KBPS=2048 ./deploy/install.sh
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mxx\033[0m %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "Please run as root: sudo ./deploy/install.sh"
[ -f docker-compose.yml ] || die "Run this from the Skyload folder (the one with docker-compose.yml)."

random_b64() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
random_hex() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# ── Docker ───────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is missing. Install it with: apt-get install docker-compose-plugin"

# ── Swap (the first build needs about 2 GB of memory) ────────────────────────
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 3000000 ] && ! swapon --show | grep -q .; then
  say "Adding a 2 GB swap file (this server has under 3 GB of RAM)"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# ── Configuration ────────────────────────────────────────────────────────────
if [ -f .env ]; then
  say "Keeping existing .env"
  DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
else
  say "A few questions (you can change answers later in the .env file)"
  ask() { # ask VAR "question" [default]: skipped when VAR is already set in the environment
    if [ -z "${!1:-}" ]; then
      read -rp "$2${3:+ [$3]}: " "$1"
      [ -n "${!1}" ] || printf -v "$1" '%s' "${3:-}"
    fi
  }
  ask DOMAIN "Domain for Skyload, already pointing at this server (e.g. skyload.example.com)"
  DOMAIN=${DOMAIN#https://}
  DOMAIN=${DOMAIN#http://}
  DOMAIN=${DOMAIN%/}
  [ -n "$DOMAIN" ] || die "A domain is required for HTTPS and Google sign-in."
  ask GOOGLE_CLIENT_ID "Google OAuth client ID"
  ask GOOGLE_CLIENT_SECRET "Google OAuth client secret"
  ask GOOGLE_DRIVE_SCOPE "Google Drive access, 'full' or 'file' (see DEPLOY.md)" full
  ask MAX_TORRENT_SIZE_GB "Largest torrent allowed, in GB" 50

  umask 077
  cat >.env <<EOF
# Written by deploy/install.sh on $(date -u +%Y-%m-%d). Keep this file private.
DOMAIN=$DOMAIN
APP_URL=https://$DOMAIN
# Encrypts stored cloud logins. Back it up; if it changes, everyone must reconnect.
ENCRYPTION_KEY=$(random_b64)
POSTGRES_PASSWORD=$(random_hex)

GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
GOOGLE_DRIVE_SCOPE=$GOOGLE_DRIVE_SCOPE

# Optional extra clouds (see DEPLOY.md). Leave empty to hide them.
DROPBOX_APP_KEY=
DROPBOX_APP_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MEGA_ENABLED=true

MAX_TORRENT_SIZE_GB=$MAX_TORRENT_SIZE_GB
MAX_ACTIVE_JOBS_PER_USER=2
WORKER_CONCURRENCY=3
TORRENT_PORT=6881
# Caps how fast we upload to other peers (0 = unlimited). Useful where outbound traffic is billed.
TORRENT_UPLOAD_LIMIT_KBPS=${TORRENT_UPLOAD_LIMIT_KBPS:-0}
EOF
  umask 022
  [ -n "$GOOGLE_CLIENT_ID" ] || warn "No Google client ID yet. Add it to .env, then run: docker compose up -d"
fi

# ── DNS check ────────────────────────────────────────────────────────────────
public_ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
domain_ip=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
if [ -n "$public_ip" ] && [ "$public_ip" != "$domain_ip" ]; then
  warn "$DOMAIN points to '${domain_ip:-nothing}', but this server is $public_ip."
  warn "Create a DNS A record: $DOMAIN -> $public_ip. HTTPS starts working a few minutes after it updates."
fi

# ── Firewall ─────────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening ports 80, 443 and 6881 in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw allow 6881 >/dev/null
fi

# ── Start ────────────────────────────────────────────────────────────────────
say "Building and starting Skyload (the first build takes a few minutes)"
docker compose up -d --build

say "Waiting for the app to come up"
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 3
done
[ "${ready:-}" = 1 ] || die "The app didn't start. See the logs with: docker compose logs app"

cat <<EOF

$(printf '\033[1;32m')Skyload is running.$(printf '\033[0m')

  Open:  https://$DOMAIN

  In Google Cloud Console, your OAuth client must list this redirect URI:
         https://$DOMAIN/api/auth/callback/gdrive

  Logs:     docker compose logs -f app
  Update:   git pull && docker compose up -d --build
  Settings: edit .env, then docker compose up -d
EOF
