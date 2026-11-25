#!/usr/bin/env bash
# Deploys the orchestrator and the test anchor to the production host.
#
#   deploy/deploy.sh                 # uses DEPLOY_HOST (default root@46.225.47.201)
#   deploy/deploy.sh --render-only   # steps 1-2 only: renders deploy/.secrets locally, no SSH (then pnpm release-check)
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
RENDER_ONLY=0
# Strict: anything but no argument or --render-only stops here, so a typo never deploys (S3-2).
case "$#:${1:-}" in
  0:) ;;
  1:--render-only) RENDER_ONLY=1 ;;
  *) echo "usage: deploy/deploy.sh [--render-only]  (got: $*)" >&2; exit 2 ;;
esac

[ -f .env.testnet ] || { echo ".env.testnet missing: run pnpm seed-testnet first"; exit 1; }
get() { grep "^$1=" .env.testnet | cut -d= -f2-; }
[ "$(grep -c '^CHANNEL_SECRETS=' .env.testnet)" = 1 ] || { echo "CHANNEL_SECRETS must appear exactly once in .env.testnet: run pnpm create-channels first, or fix it by hand"; exit 1; }
[ -n "$(get CHANNEL_SECRETS)" ] || { echo "CHANNEL_SECRETS missing in .env.testnet: run pnpm create-channels first"; exit 1; }
mkdir -p "$SECRETS"

# 1. The anchor's production config: public URLs, Corra as client domain, its own secrets
#    (kept across deploys because setup.ts reuses secrets already in the output folder).
ANCHOR_CONFIG_OUT="$PWD/$SECRETS/anchor" \
ANCHOR_PUBLIC_URL=https://anchor.corra.money \
CORRA_CLIENT_DOMAIN=api.corra.money \
CORRA_CALLBACK_URL=https://api.corra.money/callbacks/sep24 \
  pnpm exec tsx infra/anchor/setup.ts

# 2. The orchestrator's environment: the sponsor key, the channel keys and the client_domain key, nothing else.
#    CORRA_LOCAL_SETUP_LIMITS is never rendered: production keeps the default /setup limits.
cat > "$SECRETS/orchestrator.env" <<ENV
PORT=8787
DATABASE_URL=postgres://corra:corra@corra-db:5432/corra
FEE_SPONSOR_SECRET=$(get FEE_SPONSOR_SECRET)
CLIENT_DOMAIN_SIGNING_SECRET=$(get CLIENT_DOMAIN_SIGNING_SECRET)
CHANNEL_SECRETS=$(get CHANNEL_SECRETS)
ANCHOR_HOME_DOMAIN=http://platform:8080
CORRA_CLIENT_DOMAIN=api.corra.money
CORS_ORIGINS=https://app.corra.money,http://localhost:5180
ENV
chmod 600 "$SECRETS/orchestrator.env"

if [ "$RENDER_ONLY" = 1 ]; then
  echo "rendered $SECRETS/orchestrator.env and $SECRETS/anchor (values not printed); nothing sent. Next: pnpm release-check"
  exit 0
fi

# 3. Ship the source (no secrets, no builds, no node_modules), then the secrets separately.
#    --delete never reaches $DIR/backups (backups belong in /opt/corra-backups, outside $DIR).
"${SSH[@]}" "mkdir -p $DIR/infra/anchor/generated $DIR/deploy"
rsync -az --delete -e "ssh $SSH_OPTS" \
  --exclude node_modules --exclude .git --exclude dist --exclude '.env*' \
  --exclude /app --exclude /landing --exclude /assets --exclude /evidence --exclude /.local-stack --exclude /backups \
  --exclude infra/anchor/generated --exclude deploy/.secrets --exclude deploy/orchestrator.env \
  ./ "$HOST:$DIR/"
rsync -az -e "ssh $SSH_OPTS" "$SECRETS/anchor/" "$HOST:$DIR/infra/anchor/generated/"
rsync -az -e "ssh $SSH_OPTS" "$SECRETS/orchestrator.env" "$HOST:$DIR/deploy/orchestrator.env"
"${SSH[@]}" "chmod 600 $DIR/deploy/orchestrator.env $DIR/infra/anchor/generated/*.env"

# 4. GoatCounter must have its site before Caddy routes stats.corra.money to it: an empty GoatCounter
#    serves an unauthenticated "Create your first site and user" form, so anyone could claim admin.
#    Nothing is started until the site exists (the source above is shipped, so the command below works).
if ! "${SSH[@]}" "cd $DIR && docker compose -f deploy/docker-compose.yml run --rm --no-deps goatcounter db show site -find=stats.corra.money >/dev/null 2>&1"; then
  echo "GoatCounter has no site for stats.corra.money yet: nothing was started. Create it (it asks for a password), then rerun deploy/deploy.sh:"
  echo "  ssh -t -i $KEY $HOST 'cd $DIR && docker compose -f deploy/docker-compose.yml run --rm --no-deps goatcounter db create site -createdb -vhost=stats.corra.money -user.email=<builder email>'"
  exit 1
fi

# 5. Build and start. Caddy and the platform read mounted config files that `up` does not watch, so restart them.
"${SSH[@]}" "cd $DIR && docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans && docker compose -f deploy/docker-compose.yml restart caddy platform && docker compose -f deploy/docker-compose.yml ps"
