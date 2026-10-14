#!/usr/bin/env bash
# Deploys the orchestrator and the test anchor to the production host.
#
#   deploy/deploy.sh                 # uses DEPLOY_HOST (default root@46.225.47.201)
#
# Needs .env.testnet (from pnpm seed-testnet) and the SSH key at ~/.ssh/corra-hetzner.
# Secrets are rendered locally into deploy/.secrets (gitignored) and copied over SSH; they are
# never committed and never baked into an image.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-root@46.225.47.201}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/corra-hetzner}"
DIR=/opt/corra
# One shared connection for every step: fewer handshakes, so a flaky network path (e.g. a VPN)
# drops one deploy step less often.
CTL="$HOME/.ssh/corra-deploy-%C"
SSH_OPTS="-i $KEY -o ControlMaster=auto -o ControlPath=$CTL -o ControlPersist=120 -o ConnectTimeout=20"
SSH=(ssh $SSH_OPTS "$HOST")
SECRETS=deploy/.secrets

[ -f .env.testnet ] || { echo ".env.testnet missing: run pnpm seed-testnet first"; exit 1; }
get() { grep "^$1=" .env.testnet | cut -d= -f2-; }
mkdir -p "$SECRETS"

# 1. The anchor's production config: public URLs, Corra as client domain, its own secrets
#    (kept across deploys because setup.ts reuses secrets already in the output folder).
ANCHOR_CONFIG_OUT="$PWD/$SECRETS/anchor" \
ANCHOR_PUBLIC_URL=https://anchor.corra.money \
CORRA_CLIENT_DOMAIN=api.corra.money \
CORRA_CALLBACK_URL=https://api.corra.money/callbacks/sep24 \
  pnpm exec tsx infra/anchor/setup.ts

# 2. The orchestrator's environment: the one sponsor key and the client_domain key, nothing else.
cat > "$SECRETS/orchestrator.env" <<ENV
PORT=8787
DATABASE_URL=postgres://corra:corra@corra-db:5432/corra
FEE_SPONSOR_SECRET=$(get FEE_SPONSOR_SECRET)
CLIENT_DOMAIN_SIGNING_SECRET=$(get CLIENT_DOMAIN_SIGNING_SECRET)
ANCHOR_HOME_DOMAIN=http://platform:8080
CORRA_CLIENT_DOMAIN=api.corra.money
CORS_ORIGINS=https://app.corra.money,http://localhost:5180
ENV

# 3. Ship the source (no secrets, no builds, no node_modules), then the secrets separately.
"${SSH[@]}" "mkdir -p $DIR/infra/anchor/generated $DIR/deploy"
rsync -az --delete -e "ssh $SSH_OPTS" \
  --exclude node_modules --exclude .git --exclude dist --exclude '.env*' \
  --exclude /app --exclude /landing --exclude /assets \
  --exclude infra/anchor/generated --exclude deploy/.secrets --exclude deploy/orchestrator.env \
  ./ "$HOST:$DIR/"
rsync -az -e "ssh $SSH_OPTS" "$SECRETS/anchor/" "$HOST:$DIR/infra/anchor/generated/"
rsync -az -e "ssh $SSH_OPTS" "$SECRETS/orchestrator.env" "$HOST:$DIR/deploy/orchestrator.env"
"${SSH[@]}" "chmod 600 $DIR/deploy/orchestrator.env $DIR/infra/anchor/generated/*.env"

# 4. Build and start.
"${SSH[@]}" "cd $DIR && docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans && docker compose -f deploy/docker-compose.yml ps"
