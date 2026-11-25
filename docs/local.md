# Local stack

Everything Corra needs, on localhost, against Stellar **testnet**: the app, the orchestrator, the test anchor, Postgres and a local GoatCounter. Every Freighter check runs here first; production comes after.

## 1. What runs where

| Service | Where | Notes |
|---|---|---|
| App | http://localhost:5173 | Vite dev server, pointed at the local orchestrator and anchor |
| Orchestrator | http://localhost:8787/health | log `.local-stack/orchestrator.log`; keys from `.env.testnet` |
| Anchor (SEP) | http://localhost:8080/sep24/info | SDF Anchor Platform (`infra/anchor`) |
| Anchor page | http://localhost:8091 | the test anchor's business server (simulated SPEI) |
| Postgres | localhost:5434 | Corra's ledger (`docker compose`, volume `pgdata`) |
| Stats | http://stats.localhost:8094 | GoatCounter for localhost visits (volume `goatcounter-data`); log in as `local@corra.test`, password in `.local-stack/goatcounter.pass` (made by `local:up`, never printed) |
| Lending pool | Stellar testnet contract, printed by `local:up` | Corra's Blend pool (On-Ice, 0%); ids in `packages/shared/src/testnet-blend.ts`, written by `pnpm deploy-pool`. App and orchestrator read the same file; `null` means no pool routes or card |

## 2. Prerequisites

- Node 22 and pnpm 9 (`nvm use 22`; the script sources nvm itself when it finds it)
- OrbStack or Docker, running
- `pnpm install`
- `.env.testnet` from `pnpm seed-testnet`, once. It creates new testnet accounts; never commit it. **Never run `pnpm seed-testnet --force` on the team's keys**: it makes new random keys, so every address and Stellar Asset Contract id the SOW names changes. After a testnet reset use `pnpm redeploy-after-reset` ([testnet-reset](testnet-reset.md)).
- `pnpm create-channels`, once (and again after `pnpm seed-testnet --force`, which rewrites `.env.testnet`): five friendbot-funded channel accounts, their secrets appended to `.env.testnet` as `CHANNEL_SECRETS` (never printed), their public keys in `packages/shared/src/testnet-channels.ts`. `local:up` refuses to start without them.
- `local:up` starts the orchestrator with `CORRA_LOCAL_SETUP_LIMITS=1` (`/setup` 200 per IP per 10 minutes, since every script shares this machine's IP). It is honoured only with a `http://localhost` anchor; never put it in `.env.testnet` or production.
- Freighter, set to Testnet, for the clicks in section 4

## 3. Commands

```bash
pnpm local:up       # start or reuse everything; prints the URLs and a Freighter checklist
pnpm local:status   # one line per service: up or down
pnpm local:check    # health, CORS, the live UI-path check, a headless DOM smoke (not a layout or width check)
pnpm local:down     # stop everything; data is kept
```

Logs and pid files are in `.local-stack/` (gitignored). `local:up` is safe to run again: running services are reused, except that it restarts the orchestrator when a file under `services/orchestrator/src` or `packages/*/src` changed after it started (it runs without watch), and restarts the web app when its pid is alive but http://localhost:5173 does not answer. The app itself reloads web code changes on its own. A pid file left by a reboot or crash is trusted only while that pid is still the process the script started (its command names `@corra/orchestrator` or `@corra/web` and its start time matches); otherwise it is removed and nothing is signalled. `bash scripts/local-stack.test.sh` checks this.

`local:check` also proves the served app points at the local orchestrator (`http://localhost:8787`) and anchor (`localhost:8080`), checks that the orchestrator serves the pool (a junk `/pool/submit` is `REFUSED`), then runs the app's own modules (`wallet`, `deposit`, `remit`, `pool`, `blend`, `history`, `api`, `anchor`, `vals`) in Node with a fresh keypair standing in for Freighter: sponsored setup, Add money 600 with a simulated SPEI transfer, PHP 500 paid from the balance, 20 TESTMXN into the pool and all of it back, and every entry in History. Each run costs one sponsored setup, 600 TESTMXN, about 165 TESTMXN through the PHP book and two pool fee-bumps paid by the sponsor. The headless DOM smoke needs Google Chrome; without it the step prints SKIP.

## 4. Freighter on localhost

Open http://localhost:5173 (not 127.0.0.1). What each prompt is:

- **Connect Wallet**: a SEP-10 sign-in at the anchor, co-signed by Corra's client_domain key. Never submitted, moves nothing.
- **Set up your account** (Balance tab): one transaction adding the TESTMXN trustline. Corra sponsors the reserves and the fee, so the account needs no XLM.
- **Add money**: normally no prompt; if your anchor session has expired you get one SEP-10 sign-in prompt first (never submitted, moves nothing). Corra records the deposit, the anchor's page opens on your click, and "Simulate SPEI transfer received" there makes the anchor pay TESTMXN into your account.
- **Sign and send, paying from your balance**: one prompt, a path payment from your account, valid 5 minutes, submitted at once. Paying at the anchor instead keeps the Phase 1 flow (sign first, deposit after).
- **Move to pool / Take back** (Balance tab, Lending pool card): one prompt, a contract call to the pool's `submit` from your account, valid 3 minutes. Corra checks it and pays the fee; the TESTMXN stays yours in the pool contract.
- **Cash out** (Cash out tab, for a TESTPHP payment you received): Set up for cash-out needs no prompt when you already hold TESTPHP (one prompt otherwise). Cash out opens the withdrawal at the anchor; confirm it on the anchor's page, then **Sign the withdrawal**: one prompt, a payment from your account to the anchor's distribution account with the anchor's memo, valid 5 minutes. Corra checks it and pays the fee; the anchor's business server (a 5 s poller) sees the payment and simulates the cash pickup.

The full click lists are in HUMAN-TASKS.md (u2-d1-web-local, u3-d2-blend-pool).

## 4a. Counting user tests

The app counts page views and three events (`wallet-connect`, `quote`, `sign`) in the local GoatCounter. Give each user test its own link, so its visit and events carry the tag:

```
http://localhost:5173/?utm_campaign=cdp&utm_source=U1      # U1 to U4: user tests
https://app.corra.money/?utm_campaign=cdp&utm_source=S3    # S: interviews, B: builder demos (production)
```

The tag (S, B or U and 1-99) is kept for the browser tab, so the events after the first page still carry it. For the Day-29 report, export CSV from both instances (local: http://stats.localhost:8094, Settings, Export; production: https://stats.corra.money) and count visit, connect, quote and sign per tag. A headless run (`local:check`) is not a browser visit and adds nothing.

## 5. Optional proofs on the same stack

```bash
pnpm balance-check     # five corridors paid from the balance (about 712 TESTMXN and one setup)
pnpm anchor-check      # setup, SEP-10, SEP-24 deposit, simulated SPEI, signed callback
pnpm drive-payment     # one Phase 1 payment through the API and the anchor to CREDITED (cash_out leg PENDING)
pnpm drive-payment --cash-out   # the same, then the recipient cashes out at the anchor (SEP-24 TESTPHP withdrawal)
pnpm anchor-trustline  # once per seed: the anchor distribution account's TESTPHP trustline
pnpm pool-check        # the D2 go/no-go: a 0-XLM account supplies 20 TESTMXN and withdraws it all through /pool/submit
pnpm pool-check --verify-only   # only that the pool is still On-Ice, borrowing off, ours, and alive 14+ days
pnpm ops-check         # read-only: health, sponsor and channel XLM, offers and paths, the anchor's assets, the pool's TTL, keys
pnpm redeploy-after-reset       # read-only plan of the testnet rebuild; every step "done" on a healthy testnet
```

Evidence: these scripts write JSON under `evidence/2026-12/<phase>/` (`EVIDENCE_PHASE`; unset it is `pre-reset` until the 2026-12-16 reset and an error after it); see [evidence/2026-12/README.md](../evidence/2026-12/README.md). After a testnet reset follow [testnet-reset](testnet-reset.md).

## 6. Troubleshooting

- **Port busy**: `local:up` stops and names the process holding 5173 or 8787. Stop it and run again. The app must be on 5173: the orchestrator's CORS allows that origin.
- **Anchor slow to start**: the Anchor Platform image is amd64 and runs emulated on Apple Silicon; a cold start can take minutes. `local:up` waits up to 5 minutes and prints the anchor's logs if it gives up.
- **First connect fails once** with "Unable to read client_domain's SIGNING_KEY" after an orchestrator restart: the anchor reused a dead pooled connection. Connect again.
- **"Too many account setups"**: `/setup` allows 5 per IP per 10 minutes. Wait, or reuse an account that is already set up.
- **"Invalid session" on the anchor's page**: the page link is valid for 10 minutes (Anchor Platform default `jwt_expiration` 600 s). Start over on the Balance tab.
- **422 about the sequence right after a payment landed**: Horizon had not caught up yet. Press Sign and send again.
- **The pool card says "not deployed"**: `testnet-blend.ts` is `null` or the pool is gone (a testnet reset): `pnpm deploy-pool --redeploy`, then `pnpm local:up` restarts the orchestrator. `--redeploy` refuses while the recorded pool still holds deposits: the app and `/pool/submit` serve only the recorded pool, so a 0-XLM user could not withdraw from the old one. It prints the amount and the accounts with a supply; `--strand-deposits` replaces the pool anyway and the evidence JSON records that. **"A pool record is archived"**: `pnpm pool-ttl`.
- **Docker hangs**: turn Cloudflare WARP off; it breaks OrbStack networking.
- **Wiping data**: `docker compose -f infra/anchor/docker-compose.yml down` wipes the anchor's records (its database has no volume), so History's anchor references stop resolving there; `docker compose down -v` wipes Corra's ledger. `local:down` does neither.
- **`tx_bad_seq` once**: the local stack and production share the fee-sponsor and client_domain keys and the anchor's distribution account. They share the five channel accounts too (`deploy.sh` renders `CHANNEL_SECRETS` from the same `.env.testnet`), each process with its own in-memory leases, and both hand out the first channel first. A local and a production setup or anchor payout at the same moment can therefore collide once. A colliding payout can be retried; a colliding setup already spent the account's per-account `/setup` token (1 per 10 minutes), so that account can set up again only after up to 10 minutes (a retry before then gets `429 RATE_LIMITED`). Do not run `pnpm concurrent-setups` or the drive scripts while production takes sign-ups.

Production deploy is not part of this: `deploy/deploy.sh` and `pnpm publish-app` run only after the builder approves.
