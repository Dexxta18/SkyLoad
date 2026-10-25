#!/usr/bin/env bash
# Creates a Google Cloud VM for Skyload, with a fixed IP address and firewall rules.
# Run it in Cloud Shell (https://shell.cloud.google.com), which is already signed in:
#
#   gcloud config set project YOUR_PROJECT_ID
#   git clone https://github.com/Dexxta18/SkyLoad.git skyload
#   bash skyload/deploy/gcp-create-vm.sh
#
# Settings can be overridden, e.g.  REGION=europe-west3 MACHINE=e2-standard-2 bash gcp-create-vm.sh
# Safe to run again: anything that already exists is reused.
set -euo pipefail

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}
REGION=${REGION:-europe-west1}
ZONE=${ZONE:-${REGION}-b}
NAME=${NAME:-skyload}
MACHINE=${MACHINE:-e2-medium}
DISK_GB=${DISK_GB:-100}

say() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mxx\033[0m %s\n' "$*" >&2
  exit 1
}

[ -n "$PROJECT" ] || die "Choose a project first: gcloud config set project YOUR_PROJECT_ID"
say "Project $PROJECT, zone $ZONE, $MACHINE with a ${DISK_GB} GB disk"

say "Enabling the Compute Engine and Google Drive APIs (needs billing enabled on the project)"
gcloud services enable compute.googleapis.com drive.googleapis.com --project "$PROJECT"

say "Reserving a fixed IP address"
if ! gcloud compute addresses describe "$NAME-ip" --project "$PROJECT" --region "$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$NAME-ip" --project "$PROJECT" --region "$REGION"
fi
IP=$(gcloud compute addresses describe "$NAME-ip" --project "$PROJECT" --region "$REGION" --format='value(address)')

say "Opening the firewall for the website (80, 443) and BitTorrent peers (6881)"
if ! gcloud compute firewall-rules describe "$NAME-web" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$NAME-web" --project "$PROJECT" --network default \
    --allow tcp:80,tcp:443,udp:443 --target-tags "$NAME" --source-ranges 0.0.0.0/0 \
    --description "Skyload website"
fi
if ! gcloud compute firewall-rules describe "$NAME-peers" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$NAME-peers" --project "$PROJECT" --network default \
    --allow tcp:6881,udp:6881 --target-tags "$NAME" --source-ranges 0.0.0.0/0 \
    --description "Skyload incoming BitTorrent peers"
fi

say "Creating the VM"
if ! gcloud compute instances describe "$NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$NAME" --project "$PROJECT" --zone "$ZONE" \
    --machine-type "$MACHINE" \
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size "${DISK_GB}GB" --boot-disk-type pd-balanced \
    --address "$IP" --tags "$NAME"
fi

cat <<EOF

$(printf '\033[1;32m')Server ready.$(printf '\033[0m') Its IP address is: $IP

Next:
  1. In your domain's DNS, add an A record:  skyload  ->  $IP
  2. Connect to the server from this Cloud Shell:
       gcloud compute ssh $NAME --zone $ZONE
  3. On the server, install Skyload (see DEPLOY.md):
       sudo apt-get update && sudo apt-get install -y git
       git clone https://github.com/Dexxta18/SkyLoad.git skyload && cd skyload
       sudo TORRENT_UPLOAD_LIMIT_KBPS=2048 ./deploy/install.sh
EOF
