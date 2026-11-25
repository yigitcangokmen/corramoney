#!/usr/bin/env bash
# The whole stack on localhost against Stellar TESTNET, for testing with Freighter before anything
# goes to production: Postgres, the test anchor (infra/anchor), the orchestrator, the web app and a
# local GoatCounter (usage counts of localhost user tests).
#
#   pnpm local:up       start (or reuse) everything, print the URLs and the Freighter checklist
#   pnpm local:status   one line per service
#   pnpm local:check    health, CORS, the live UI-path check (keypair for Freighter), a headless DOM smoke
#   pnpm local:down     stop everything, keep the data
#
# Logs and pid files live in .local-stack/. Reads .env.testnet only through the orchestrator's own
# config and infra/anchor/setup.ts; never prints a secret.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE=.local-stack
ANCHOR_COMPOSE="docker compose -f infra/anchor/docker-compose.yml"
# GoatCounter needs a vhost with two labels (localhost alone is refused); browsers resolve *.localhost locally.
STATS_URL=http://stats.localhost:8094
STATS_PASS="$STATE/goatcounter.pass"
mkdir -p "$STATE"

say() { printf '%s\n' "$*"; }
die() { printf 'local-stack: %s\n' "$*" >&2; exit 1; }

# wait_http URL SECS: true once URL answers 2xx, false after SECS seconds.
wait_http() {
  local url=$1 secs=$2 i=0
  while [ "$i" -lt "$secs" ]; do
    if curl -sf -o /dev/null --max-time 5 "$url"; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# alive NAME: the process this script started as NAME is still running. A pid file survives reboots and
# crashes, so the pid must still name that process: its command carries @corra/NAME and its start time is
# the one start_bg recorded (an older pid file without a .start is checked by command only). Otherwise
# the pid file is stale: it is removed and NAME counts as not running.
alive() {
  local f="$STATE/$1.pid" pid
  [ -f "$f" ] || return 1
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= 2>/dev/null | grep -qF "@corra/$1" \
    && { [ ! -f "$STATE/$1.start" ] || [ "$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null)" = "$(cat "$STATE/$1.start")" ]; }; then
    return 0
  fi
  rm -f "$f" "$STATE/$1.start"
  return 1
}

# orchestrator_stale: a source file under services/orchestrator/src or packages/*/src changed after the
# running orchestrator started (tsx runs without watch, so it would keep serving the old code).
orchestrator_stale() {
  [ -n "$(find services/orchestrator/src packages/*/src -type f -newer "$STATE/orchestrator.pid" -print 2>/dev/null | head -n 1)" ]
}

# The Blend pool the app and the orchestrator use (packages/shared/src/testnet-blend.ts), or "not deployed".
pool_id() {
  grep -oE "pool: '[A-Z2-7]{56}'" packages/shared/src/testnet-blend.ts 2>/dev/null | grep -oE '[A-Z2-7]{56}' || echo "not deployed (pnpm deploy-pool)"
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_owner() { lsof -nP -iTCP:"$1" -sTCP:LISTEN | awk 'NR > 1 { print "pid " $2 " (" $1 ")" }' | sort -u | tr '\n' ' '; }

# start_bg NAME CMD...: runs CMD in its own process group, so stop_bg can stop pnpm, tsx and node together.
start_bg() {
  local name=$1
  shift
  set -m
  nohup "$@" > "$STATE/$name.log" 2>&1 < /dev/null &
  echo $! > "$STATE/$name.pid"
  LC_ALL=C ps -p $! -o lstart= > "$STATE/$name.start"
  set +m
}

# stop_bg NAME: signals only a process alive NAME vouches for; a stale pid file is just removed.
stop_bg() {
  local f="$STATE/$1.pid" pid i=0
  alive "$1" || return 0
  pid=$(cat "$f")
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 5 ]; do sleep 1; i=$((i + 1)); done
  kill -KILL -- "-$pid" 2>/dev/null || true
  rm -f "$f" "$STATE/$1.start"
}

# stats_answers: the local GoatCounter serves count.js for its site.
stats_answers() { curl -sf -o /dev/null --max-time 5 -H 'Host: stats.localhost' http://127.0.0.1:8094/count.js; }

# stats_up: starts GoatCounter and creates its stats.localhost site once (password kept in $STATS_PASS, never printed).
stats_up() {
  docker compose up -d goatcounter >/dev/null 2>&1 || { docker compose up -d goatcounter; exit 1; }
  if [ ! -s "$STATS_PASS" ]; then
    (umask 077 && openssl rand -hex 12 > "$STATS_PASS")
  fi
  chmod 600 "$STATS_PASS"
  local i=0
  until curl -s -o /dev/null --max-time 2 http://127.0.0.1:8094/ || [ "$i" -ge 30 ]; do sleep 1; i=$((i + 1)); done
  if ! docker compose exec -T goatcounter goatcounter db show site -find=stats.localhost >/dev/null 2>&1; then
    docker compose exec -T goatcounter goatcounter db create site -vhost=stats.localhost -user.email=local@corra.test \
      -user.password="$(cat "$STATS_PASS")" >/dev/null || die "could not create the local GoatCounter site."
  fi
  stats_answers || die "GoatCounter does not serve $STATS_URL/count.js."
}

preflight() {
  command -v docker >/dev/null 2>&1 || export PATH="$HOME/.orbstack/bin:$PATH"
  docker info >/dev/null 2>&1 || die "Docker is not running. Start OrbStack/Docker, then run this again."
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -lt 22 ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm use 22 --silent >/dev/null || true
    set -u
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  fi
  [ "$major" -ge 22 ] || die "Node 22 required (nvm install 22)."
  [ -d node_modules ] || die "run pnpm install first."
  [ -f .env.testnet ] || die "no .env.testnet: run pnpm seed-testnet once (creates new testnet accounts)."
  grep -q '^CHANNEL_SECRETS=' .env.testnet || die "no channel accounts: run pnpm create-channels once."
  if pgrep -x "Cloudflare WARP" >/dev/null 2>&1; then
    say "warning: WARP breaks OrbStack networking; turn it off if docker hangs."
  fi
}

up() {
  preflight

  say "postgres..."
  docker compose up -d --wait postgres >/dev/null

  say "stats (GoatCounter)..."
  stats_up

  say "anchor (Anchor Platform + business server; the first start can take minutes)..."
  pnpm exec tsx infra/anchor/setup.ts >/dev/null
  $ANCHOR_COMPOSE up -d --build >/dev/null 2>&1 || { $ANCHOR_COMPOSE up -d --build; exit 1; }
  if ! wait_http http://localhost:8080/.well-known/stellar.toml 300 || ! wait_http http://localhost:8091/health 60; then
    $ANCHOR_COMPOSE logs --tail 60 platform anchor-business
    die "the anchor did not come up."
  fi

  say "orchestrator..."
  if alive orchestrator && orchestrator_stale; then
    say "  backend code changed since it started: restarting"
    stop_bg orchestrator
  fi
  if alive orchestrator && curl -sf -o /dev/null --max-time 5 http://localhost:8787/health; then
    say "  already running (pid $(cat "$STATE/orchestrator.pid"))"
  else
    stop_bg orchestrator
    port_busy 8787 && die "port 8787 is taken by $(port_owner 8787); stop it, then run this again."
    # CORRA_LOCAL_SETUP_LIMITS=1: the scripts share this machine's IP; the orchestrator honours it only with a localhost anchor.
    start_bg orchestrator env ANCHOR_HOME_DOMAIN=http://localhost:8080 CORRA_LOCAL_SETUP_LIMITS=1 pnpm --filter @corra/orchestrator start
    if ! wait_http http://localhost:8787/health 90; then
      tail -n 40 "$STATE/orchestrator.log"
      die "the orchestrator did not come up (log $STATE/orchestrator.log)."
    fi
  fi

  say "web..."
  if alive web && curl -sf -o /dev/null --max-time 5 http://localhost:5173/; then
    say "  already running (pid $(cat "$STATE/web.pid"))"
  else
    stop_bg web
    port_busy 5173 && die "port 5173 is taken by $(port_owner 5173); stop it, then run this again."
    # The code defaults, set here so this script documents what the app points at. --strictPort:
    # a drift to 5174 would be refused by the orchestrator's CORS.
    start_bg web env VITE_ORCHESTRATOR_URL=http://localhost:8787 VITE_ANCHOR_DOMAIN=localhost:8080 \
      VITE_CLIENT_DOMAIN=host.docker.internal:8787 VITE_STATS_URL="$STATS_URL" pnpm --filter @corra/web exec vite --port 5173 --strictPort
    if ! wait_http http://localhost:5173/ 60; then
      tail -n 40 "$STATE/web.log"
      die "the web app did not come up (log $STATE/web.log)."
    fi
  fi

  cat <<'EOF'

Corra local stack is up (Stellar TESTNET, local anchor, local orchestrator).
  App            http://localhost:5173
  Orchestrator   http://localhost:8787/health     log .local-stack/orchestrator.log
  Anchor (SEP)   http://localhost:8080/sep24/info  anchor page http://localhost:8091
  Postgres       localhost:5434
  Stats          http://stats.localhost:8094 (local@corra.test, password in .local-stack/goatcounter.pass)
  Setup limits   local (200 per IP per 10 min)
EOF
  say "  Pool           $(pool_id)"
  cat <<'EOF'
  Prove          pnpm local:check   (keypair stands in for Freighter: deposit 600 + one send from balance + pool 20 in and out)
  Stop           pnpm local:down
Freighter checklist (Testnet, open http://localhost:5173, details in HUMAN-TASKS.md u2-d1-web-local):
  1. Connect Wallet. If the first connect says "Unable to read client_domain's SIGNING_KEY", connect again.
  2. Balance: Set up your account, Add money 600, Open the anchor's page, Simulate SPEI.
  3. History: the deposit with its anchor reference and links.
  4. Send PH 500 to the demo recipient: Review shows "Pay from my balance now", one prompt, Recipient credited.
  Note: /setup allows 200 per IP per 10 minutes here (local only; production allows 5).
  Note: Add money allows 3 deposits per account and 10 per network per 10 minutes; each local:check run uses one of
    this network's 10. If you see Too many deposits, wait 10 minutes. A second Freighter account for HUMAN-TASKS.md
    steps 11-12 (popup blocked, reload during a deposit) only gets around the per-account limit.
EOF
}

down() {
  command -v docker >/dev/null 2>&1 || export PATH="$HOME/.orbstack/bin:$PATH"
  stop_bg web
  stop_bg orchestrator
  # stop, never down: the anchor's database has no volume, and down would wipe its records.
  $ANCHOR_COMPOSE stop >/dev/null 2>&1 || true
  docker compose stop postgres goatcounter >/dev/null 2>&1 || true
  say 'Stopped. Data kept. `docker compose -f infra/anchor/docker-compose.yml down` wipes the anchor'"'"'s records; `docker compose down -v` wipes Corra'"'"'s.'
}

line() { if "${@:2}"; then say "  $1 up"; else say "  $1 down"; fi; }

status() {
  command -v docker >/dev/null 2>&1 || export PATH="$HOME/.orbstack/bin:$PATH"
  line "postgres       :5434" docker compose exec -T postgres pg_isready -U corra -q
  line "anchor         :8080" curl -sf -o /dev/null --max-time 5 http://localhost:8080/.well-known/stellar.toml
  line "anchor page    :8091" curl -sf -o /dev/null --max-time 5 http://localhost:8091/health
  line "orchestrator   :8787" curl -sf -o /dev/null --max-time 5 http://localhost:8787/health
  line "web            :5173" curl -sf -o /dev/null --max-time 5 http://localhost:5173/
  line "goatcounter    :8094" stats_answers
}

pass() { say "PASS $*"; }
fail() { say "FAIL $*"; exit 1; }

check() {
  local u
  for u in http://localhost:8787/health http://localhost:8080/.well-known/stellar.toml http://localhost:8091/health http://localhost:5173/; do
    curl -sf -o /dev/null --max-time 5 "$u" && pass "200 $u" || fail "no 200 from $u (pnpm local:up?)"
  done
  curl -sf --max-time 5 http://localhost:8080/sep24/info | grep -q '"TESTMXN"' && pass "anchor SEP-24 lists TESTMXN" || fail "anchor SEP-24 info has no TESTMXN"
  curl -s -D - -o /dev/null --max-time 5 -H 'Origin: http://localhost:5173' http://localhost:8787/health \
    | grep -qi '^access-control-allow-origin: http://localhost:5173' && pass "orchestrator CORS allows http://localhost:5173" \
    || fail "orchestrator CORS does not allow http://localhost:5173"
  curl -sf --max-time 5 http://localhost:5173/src/logic/api.ts | grep -q '"VITE_ORCHESTRATOR_URL": "http://localhost:8787"' \
    && curl -sf --max-time 5 http://localhost:5173/src/logic/anchor.ts | grep -q '"VITE_ANCHOR_DOMAIN": "localhost:8080"' \
    && pass "served app points at orchestrator http://localhost:8787 and anchor localhost:8080" \
    || fail "served app does not point at the local orchestrator and anchor (pnpm local:down, then pnpm local:up)"
  stats_answers && curl -sf --max-time 5 http://localhost:5173/src/main.tsx | grep -qF "\"VITE_STATS_URL\": \"$STATS_URL\"" \
    && pass "stats endpoint $STATS_URL/count.js answers and the served app counts there" \
    || fail "no stats endpoint, or the served app does not count at $STATS_URL (pnpm local:down, then pnpm local:up)"
  curl -sf --max-time 5 http://localhost:8787/.well-known/stellar.toml | grep -q SIGNING_KEY \
    && pass "Corra stellar.toml publishes SIGNING_KEY" || fail "Corra stellar.toml has no SIGNING_KEY"
  curl -s --max-time 5 -X POST -H 'content-type: application/json' -H 'idempotency-key: local-check' \
    -d '{"signedXdr":"AAAA"}' http://localhost:8787/pool/submit | grep -q '"REFUSED"' \
    && pass "orchestrator serves the pool $(pool_id) (a junk submit is REFUSED)" || fail "orchestrator has no pool (pnpm deploy-pool?)"

  say "live UI path (the app's own modules, a keypair for Freighter; takes a few minutes)..."
  pnpm --filter @corra/web test:live && pass "live UI path: setup, deposit 600, PHP 500 from balance, pool 20 in and out, History" || fail "live UI path"

  local chrome=""
  if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  elif command -v google-chrome >/dev/null 2>&1; then chrome=$(command -v google-chrome)
  elif command -v chromium >/dev/null 2>&1; then chrome=$(command -v chromium)
  fi
  if [ -z "$chrome" ]; then
    say "SKIP headless DOM smoke (no Chrome found)"
  else
    "$chrome" --headless=new --disable-gpu --no-first-run --window-size=390,844 --virtual-time-budget=8000 \
      --dump-dom http://localhost:5173/ > "$STATE/dom.html" 2>/dev/null
    for s in 'Connect Wallet' '>Send<' '>Balance<' '>History<'; do
      grep -q "$s" "$STATE/dom.html" || fail "headless DOM has no $s ($STATE/dom.html)"
    done
    pass "headless DOM renders Connect Wallet and the Send, Balance, History tabs (not a layout or width check)"
  fi
  say "local:check OK"
}

# Sourced by scripts/local-stack.test.sh for its functions only.
[ "${LOCAL_STACK_LIB:-}" = 1 ] && return 0

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  check) check ;;
  *) die "usage: scripts/local-stack.sh up|down|status|check" ;;
esac
