#!/usr/bin/env bash
# Ships the current commit to a Google Cloud VM set up with gcp-startup.sh:
# uploads a `git archive` to Cloud Storage, refreshes the startup script and
# reboots the VM, which then installs the new version (secrets in .env are kept).
#
#   PROJECT=skyload-dexxta BUCKET=skyload-dexxta-releases ./deploy/gcp-release.sh
#
# Settings live in instance metadata; change one with e.g.
#   gcloud compute instances add-metadata skyload --zone europe-west1-b --metadata google-client-id=...
# then run this script (or reboot the VM) to apply it.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}
BUCKET=${BUCKET:-${PROJECT}-releases}
ZONE=${ZONE:-europe-west1-b}
NAME=${NAME:-skyload}
[ -n "$PROJECT" ] || {
  echo "Set PROJECT or run: gcloud config set project YOUR_PROJECT_ID" >&2
  exit 1
}

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Note: uncommitted changes are not included; releasing $(git rev-parse --short HEAD)."
fi

tarball=$(mktemp)
trap 'rm -f "$tarball"' EXIT
git archive --format=tar.gz HEAD >"$tarball"
gcloud storage cp "$tarball" "gs://$BUCKET/releases/skyload.tar.gz" --project "$PROJECT"
gcloud compute instances add-metadata "$NAME" --project "$PROJECT" --zone "$ZONE" \
  --metadata-from-file startup-script=deploy/gcp-startup.sh
gcloud compute instances reset "$NAME" --project "$PROJECT" --zone "$ZONE"

echo "Released $(git rev-parse --short HEAD). The VM reinstalls in a minute or two; follow along with:"
echo "  gcloud compute instances get-serial-port-output $NAME --project $PROJECT --zone $ZONE | grep skyload-startup"
