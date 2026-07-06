#!/usr/bin/env bash
# 03-build-push.sh — build the container image and push it to ECR.
#
# NEXT_PUBLIC_* values are baked into the client bundle at BUILD time.
# Required env: NEXT_PUBLIC_SUPABASE_ANON_KEY
# Optional env: NEXT_PUBLIC_APP_URL (the service URL — known after first
#               deploy; rebuild with it set once you have the domain),
#               DOCKER (defaults to "sudo docker")
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
CFG="$DIR/deploy.config.json"
jqc() { python3 -c "import json;print(json.load(open('$CFG'))$1)"; }

REGION=$(jqc "['awsRegion']")
ACCOUNT=$(jqc "['awsAccountId']")
REPO=$(jqc "['ecrRepository']")
REF=$(jqc "['supabase']['projectRef']")
PROVIDER=$(jqc "['aiProvider']")
DOCKER="${DOCKER:-sudo docker}"
IMAGE="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"

: "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?set NEXT_PUBLIC_SUPABASE_ANON_KEY (the anon key is public but env-supplied to stay out of shell history)}"

echo "== build =="
$DOCKER build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="https://$REF.supabase.co" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  --build-arg NEXT_PUBLIC_AI_PROVIDER="$PROVIDER" \
  ${NEXT_PUBLIC_APP_URL:+--build-arg NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL"} \
  -t "$REPO" "$ROOT"

echo "== push =="
aws ecr get-login-password --region "$REGION" | $DOCKER login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com" >/dev/null
$DOCKER tag "$REPO:latest" "$IMAGE"
$DOCKER push -q "$IMAGE"
echo "pushed: $IMAGE"
