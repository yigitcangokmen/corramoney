# Release checklist (month 2)

The builder's approval step before anything reaches production. Agents do steps 1-2 and stop; the
builder approves and does steps 3-9. Stellar **testnet** only. No secret is ever printed: every
command below that touches one prints PASS/FAIL or public keys only.

## 1. Freeze (agents)

```bash
pnpm typecheck
pnpm test                                   # every package plus test:scripts; write the counts down
pnpm no-server-side-signing
# the five CI fixture steps of .github/workflows/ci.yml, run locally (each must fail as intended)
pnpm --filter @corra/web build
pnpm local:up && pnpm local:check && bash scripts/local-stack.test.sh
pnpm secret-scan                            # tracked, modified and untracked files; exit 0, 0 hit(s)
```

List every HUMAN-TASKS.md item as done or open.

## 2. Render (agents)

```bash
deploy/deploy.sh --render-only && pnpm release-check     # every rule PASS; nothing is sent
```

`--render-only` renders `deploy/.secrets/orchestrator.env` and `deploy/.secrets/anchor/` locally and
exits before any SSH. `release-check` checks the env keys, that no local limit or script-only secret is
rendered, that the sponsor, channel and client_domain secrets are the keys the generated files name, the
anchor's TESTPHP withdrawal and more_info secret, the Caddy routes, the compose ports, the orchestrator's
init and stop grace period, the `/backups` exclude of the `deploy.sh` rsync, the stats URL in `build:prod`, `TESTNET_BLEND`, and (R-SEC-1) the secret scan.

## 3. What the approval covers

- **Orchestrator**: migration 003 (additive), deposits, send from the balance, the pool routes, the
  cash-out leg, channel accounts, and the startup check that the sponsor key is `TESTNET.feeSponsor`.
- **Anchor**: TESTPHP withdraw, the separate more_info secret, the Caddy route for `/sep24/withdraw-confirm*`.
- **App**: the Balance card, the pool card, the Cash out tab, analytics (page view and three events).
- **stats.corra.money**: a DNS record and the GoatCounter service.

## 4. Builder: before the deploy

1. DNS: an A record `stats.corra.money` to the production host's IP.
2. Backups on the host: `pg_dump` of `corra-db` and `anchor-db` into `/opt/corra-backups/<date>/`, outside
   `/opt/corra`: `deploy.sh` syncs `/opt/corra` with `rsync --delete`, so a backup kept there would be
   deleted by the next deploy (it also excludes `/backups`, R-DEP-2, as a second guard).
3. Commits (conventional, no co-author trailer), then push. CI and Quickstart green; put the run URLs
   into `evidence/2026-12/manual.json` (item `D3.ci`).

## 5. Deploy

The GoatCounter site is created before anything routes to it: an empty GoatCounter serves an
unauthenticated "Create your first site and user" form, and whoever fills it in owns the dashboard.
`deploy.sh` therefore starts nothing until the site exists.

1. `deploy/deploy.sh`. On the first month-2 deploy it ships the source, finds no `stats.corra.money`
   site and stops before `docker compose up`, printing the command for step 2.
2. Create the site on the host (asks for the password; nothing is serving yet):
   `ssh -t -i ~/.ssh/corra-hetzner root@46.225.47.201 'cd /opt/corra && docker compose -f deploy/docker-compose.yml run --rm --no-deps goatcounter db create site -createdb -vhost=stats.corra.money -user.email=<builder>'`
3. `deploy/deploy.sh` again: the site check passes and it builds and starts everything.

Then:

- Logs show `setup.channels {count: 5, localSetupLimits: false}` and no sponsor assertion error.
- `curl https://api.corra.money/health`
- `curl https://anchor.corra.money/sep24/info`: TESTMXN deposit, TESTPHP withdraw.
- `curl -s https://stats.corra.money/ | grep -c 'Create your first site'` prints 0 (ops-check's `stats site` rule).
- `curl -s -o /dev/null -w '%{http_code}' https://stats.corra.money/count.js` prints 200 (a GET: GoatCounter 2.7.0 answers a HEAD request with 405 even when healthy).
- `pnpm publish-app`, then hard-reload https://app.corra.money.
- `ORCHESTRATOR_URL=https://api.corra.money ANCHOR_DOMAIN=anchor.corra.money STATS_URL=https://stats.corra.money pnpm ops-check`

## 6. Evidence on production

`/setup` allows 5 per IP per 10 minutes on production, so the scripts run in two windows:

- Window A: `concurrent-setups` (3 setups) and `pool-check` (1).
- Wait 10 minutes.
- Window B: `drive-payment --cash-out` (2), `balance-check` (1), `anchor-check` (1).

Each with `ORCHESTRATOR_URL=https://api.corra.money ANCHOR_DOMAIN=anchor.corra.money ANCHOR_BUSINESS_URL=https://anchor.corra.money`
and `EVIDENCE_PHASE` set. Then the Freighter run by hand (HUMAN-TASKS.md), `pnpm evidence-app-run --account G... --via-app` (only for that run in the app),
`pnpm archive-tx --phase <phase>` and `pnpm evidence-index --check`.

The walkthrough video is submitted privately, never published: its `manual.json` entry takes only a
note (no link, file or hash; `evidence-index` refuses one), and EVIDENCE.md shows it as "submitted
privately (link not published)".

## 7. Operating rules

- No local setup scripts while production takes sign-ups: both use the same channel accounts (risks.md R13).
- No deploy on a user-test day.
- Pool upkeep: `pnpm pool-ttl` extends the positions of the suppliers in the `DATABASE_URL` database only.
  For production users, run it against `corra-db` on the host (through an SSH tunnel,
  [testnet-reset.md](testnet-reset.md#keeping-the-pool-alive)); a local run leaves their positions to expire.

## 8. Rollback

Migration 003 is additive, so a Phase 1 orchestrator starts on the new schema, but it does not run
month 2 correctly on it: its saga writes the cash-out leg CONFIRMED with `mock-payout:<publicId>` for
every payment it reconciles, so a balance payment in flight or created while rolled back is "already
cashed out" (409) for good after rolling forward. It does not reconcile deposits, pool operations or
withdrawal callbacks either. So roll back only one of two ways:

- **To a month-2 commit** (the usual case): the previous month-2 commit, then `deploy/deploy.sh`.
- **To a Phase 1 commit**: drain first. Stop sign-ups, then wait until the orchestrator database holds
  no payment in `CASH_IN` or `ONCHAIN`, no pending deposit, pool operation or withdrawal; only then
  the Phase 1 commit and `deploy/deploy.sh`. Anything in flight at that moment is stranded.

The app: Vercel's previous deployment (a Phase 1 app with a Phase 1 orchestrator only).

## 9. After a testnet reset: production

Run `docs/testnet-reset.md` locally first (`pnpm redeploy-after-reset --run`). Then, on production, with
the builder's approval:

1. Stop the orchestrator, so nothing is written between the dump and the drop and it never serves an
   empty database without a schema: `docker compose -f deploy/docker-compose.yml stop orchestrator`.
   Then back up and recreate the orchestrator database (the anchor's is kept). One chain, in `/opt/corra`:
   the drop runs only when the dump succeeded and is not empty, because that dump is the only copy of the
   dropped database (and it lives outside `/opt/corra`, which the next `deploy.sh` syncs with `--delete`):

   ```bash
   B=/opt/corra-backups/<date> && mkdir -p "$B" \
     && docker compose -f deploy/docker-compose.yml exec -T corra-db pg_dump -U corra corra > "$B/corra-pre-reset.sql" \
     && test -s "$B/corra-pre-reset.sql" \
     && docker compose -f deploy/docker-compose.yml exec -T corra-db psql -U corra -d postgres -c 'DROP DATABASE corra WITH (FORCE)' -c 'CREATE DATABASE corra'
   ```
2. `deploy/deploy.sh` (ships the new `testnet-blend.ts` and the demo recipient; it starts the orchestrator again, which migrates the empty database at startup).
3. `pnpm publish-app`.
4. The checks of step 5 and the evidence of step 6, with `EVIDENCE_PHASE=post-reset`.
