#!/usr/bin/env bash
# Google Compute Engine startup script: installs or updates Skyload on every boot.
#
# Reads these instance metadata keys:
#   skyload-source         gs://bucket/path/skyload.tar.gz  (a `git archive` of the repo)
#   skyload-domain         e.g. skyload.example.com
#   google-client-id       Google OAuth client ID     (optional until you have it)
#   google-client-secret   Google OAuth client secret (optional until you have it)
#   skyload-env            extra .env lines, e.g. "MAX_TORRENT_SIZE_GB=30" (optional)
#
# Lets you deploy without SSH or GitHub access on the server: upload a new tarball,
# then reboot the VM (or change metadata and reboot) to apply. Logs go to the
# serial console:  gcloud compute instances get-serial-port-output skyload
set -euo pipefail

APP=${SKYLOAD_DIR:-/opt/skyload}
META=${METADATA_URL:-http://metadata.google.internal/computeMetadata/v1}
STORAGE=${STORAGE_URL:-https://storage.googleapis.com}

md() { curl -fsS -H 'Metadata-Flavor: Google' "$META/instance/attributes/$1" 2>/dev/null || true; }
log() { echo "skyload-startup: $*"; }

SOURCE=$(md skyload-source)
DOMAIN=$(md skyload-domain)
[ -n "$SOURCE" ] && [ -n "$DOMAIN" ] || {
  log "skyload-source / skyload-domain metadata not set; nothing to do"
  exit 0
}

if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# Fetch the code with the VM's own service account (needs storage read access).
log "downloading $SOURCE"
token=$(curl -fsS -H 'Metadata-Flavor: Google' "$META/instance/service-accounts/default/token" | sed -E 's/.*"access_token" *: *"([^"]+)".*/\1/')
bucket=${SOURCE#gs://}
bucket=${bucket%%/*}
object=${SOURCE#gs://"$bucket"/}
object_enc=$(printf '%s' "$object" | sed 's|/|%2F|g')
tmp=$(mktemp -d)
curl -fsS -H "Authorization: Bearer $token" -o "$tmp/src.tar.gz" "$STORAGE/storage/v1/b/$bucket/o/$object_enc?alt=media"

mkdir -p "$APP"
# Replace the code but keep .env (it holds the generated secrets).
find "$APP" -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +
tar -xzf "$tmp/src.tar.gz" -C "$APP"
rm -rf "$tmp"

env_file="$APP/.env"
if [ ! -f "$env_file" ]; then
  log "writing new .env with generated secrets"
  umask 077
  cat >"$env_file" <<EOF
ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
POSTGRES_PASSWORD=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
GOOGLE_DRIVE_SCOPE=full
MEGA_ENABLED=true
MAX_TORRENT_SIZE_GB=50
MAX_ACTIVE_JOBS_PER_USER=2
WORKER_CONCURRENCY=3
TORRENT_PORT=6881
TORRENT_UPLOAD_LIMIT_KBPS=2048
EOF
  umask 022
fi

# Keys managed through metadata are rewritten on every boot.
set_env() {
  grep -v "^$1=" "$env_file" >"$env_file.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
  chmod 600 "$env_file"
}
set_env DOMAIN "$DOMAIN"
set_env APP_URL "https://$DOMAIN"
set_env GOOGLE_CLIENT_ID "$(md google-client-id)"
set_env GOOGLE_CLIENT_SECRET "$(md google-client-secret)"
while IFS='=' read -r key value; do
  [ -n "$key" ] && set_env "$key" "$value"
done <<<"$(md skyload-env)"

log "building and starting"
cd "$APP"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null || true

# Report health to the serial console so it can be checked without SSH.
healthy=no
for _ in $(seq 1 40); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    healthy=yes
    break
  fi
  sleep 3
done
log "app healthy: $healthy"
docker compose ps --format '{{.Service}}: {{.Status}}' | sed 's/^/skyload-startup:   /'
docker compose logs --no-color --tail 15 app caddy 2>&1 | sed 's/^/skyload-startup:   /'
log "done"
