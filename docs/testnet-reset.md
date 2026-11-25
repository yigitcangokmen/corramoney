# Testnet reset: rebuild runbook

SDF resets Stellar **testnet** periodically; the next reset is **2026-12-16 17:00 UTC**. A reset deletes
every account, trustline, offer, contract and transaction. This page is how Corra comes back with the same
addresses. Mainnet is never involved.

## What the reset wipes, what survives

| Survives (same keys, re-created by script) | Changes |
|---|---|
| Both issuers, the market maker, the anchor's distribution account, the fee-and-sponsor account, the client_domain signer (`packages/shared/src/testnet.ts`) | Blend's pool factory and backstop (Blend redeploys them) |
| The 7 Stellar Asset Contract ids (a SAC id is derived from code, issuer and network, so the same issuer gives the same id) | Corra's oracle and pool contract ids (`testnet-blend.ts`) |
| The 5 channel accounts (`testnet-channels.ts`) and the pool admin address | The demo recipient (its secret is discarded by design, so a new one is made) |
| Every key in stellar.toml | Every user account and payment account; every transaction hash |

The keys live in `.env.testnet` (gitignored). `pnpm seed-testnet --force` would make new random keys and
rewrite `.env.testnet` whole (losing `CHANNEL_SECRETS` and `POOL_ADMIN_SECRET`) and so change the addresses
the SOW names: never use it for a reset.

## Before the reset

1. Archive every evidence hash before **2026-12-16 17:00 UTC**, while Horizon still serves it:
   `pnpm archive-tx --phase pre-reset --all` and `pnpm archive-tx --from-md EVIDENCE.md`. Soroban (pool)
   transactions also need the RPC's copy, which it keeps only for a short window: archive them within days
   of the run. After the reset, `archive-tx` refuses a pre-reset run (exit 2).
2. `pnpm evidence-index --check` green for the pre-reset items.
3. Tell the Chapter Lead the date, and that links to pre-reset transactions will stop opening; the archive
   folders keep the data.
4. Rehearsal (optional, from zero, on throwaway keys): see "Rehearsal" below.

## The rebuild

Everything written from here on is post-reset evidence; export it first, in the shell that runs the
rebuild and everything after it:

```bash
export EVIDENCE_PHASE=post-reset
```

`--run` also passes `EVIDENCE_PHASE=post-reset` to its steps by itself when it detects the reset (the
corridor issuer or the recorded pool's contract is gone), so the new pool's evidence never lands in
`pre-reset/d2`; it refuses to run with `EVIDENCE_PHASE=pre-reset` on a reset testnet.

```bash
pnpm redeploy-after-reset                        # read-only plan: each step done | todo | blocked | failed
pnpm redeploy-after-reset --run                  # runs only the steps not done, in order
pnpm redeploy-after-reset --run --wait-blend 120 # also waits (polling every 10 min) for Blend's factory, backstop and oracle WASM
```

| Step | Done when (read-only check) | Runs |
|---|---|---|
| preflight | the six base keys in `.env.testnet` are the ones `testnet.ts` names (channels and pool admin too, when both sides exist); Horizon is testnet | - (exit 1 on a mismatch) |
| seed | accounts, trustlines, balances, the 12 market-maker offers and the 7 SACs exist; the 5 corridor paths resolve | `pnpm seed-testnet --reuse-keys` |
| demo-recipient | it exists and trusts the 5 destination assets | `pnpm demo-recipient --if-missing` |
| channels | 5 channel accounts, >= 100 XLM each, own signer only | `pnpm create-channels` |
| anchor-config | `infra/anchor/generated/` names the distribution account, TESTPHP withdraw on | `pnpm exec tsx infra/anchor/setup.ts` |
| blend | Blend's `poolFactoryV2`, `backstopV2` and `oraclemock` WASM (from blend-utils) exist (deploy-pool needs all three) | waits (`--wait-blend`) |
| pool | `TESTNET_BLEND` verifies on chain. Todo only when no pool is recorded or its contract instance is gone; a recorded pool that is on chain but does not verify (or whose check throws) is `failed`, exit 2: check it with `pnpm pool-check --verify-only`, `--run` never replaces a live pool | `pnpm deploy-pool`, then `pnpm pool-check --verify-only` |
| pool-ttl | every shared pool entry lives 21+ more days | `pnpm pool-ttl` |

Exit codes: 0 all done; 3 all done except the steps waiting for Blend; 4 (plan only) steps to do, so the testnet is not rebuilt yet; 2 a step failed, or a
check failed (a check that throws, for example on a flaky RPC read, is a failure and never runs its step; fix it and run
again: done steps are skipped); 1 preflight. After `--run` it prints which team accounts submitted
transactions (sequence numbers before and after) and which generated files changed (sha1 before and after,
values never printed). On a testnet that needs nothing, it says `0 transactions submitted (idempotent)`.

The script never deploys, never runs git and never touches a database.

### The orchestrator's database

Old rows point at a chain that no longer exists (dead links in History). The builder backs the database
up and recreates it; the anchor's database is kept (nothing in Corra reads old anchor rows).

```bash
pnpm local:down
docker compose up -d postgres
docker compose exec -T postgres pg_dump -U corra corra > .local-stack/corra-pre-reset-<date>.sql
docker compose exec -T postgres psql -U corra -d postgres -c 'DROP DATABASE corra WITH (FORCE)' -c 'CREATE DATABASE corra'
pnpm local:up                                    # migrates the empty database
```

Then clear the browser's site data for http://localhost:5173 (stored deposits and cash-outs name old ids),
and run `pnpm typecheck` (the generated files changed).

## When Blend is late

`deploy-pool` needs Blend's pool factory; Corra never deploys Blend's factory itself. Until Blend
redeploys, the rebuild ends with exit 3 and the app's pool card says "The pool is not answering". The
pre-reset D2 evidence (contract, supply, withdraw, position) stays the evidence, archived under
`evidence/2026-12/pre-reset/`; say so in `evidence/2026-12/manual.json` (`notes.blend`). Run
`pnpm redeploy-after-reset --run` again once Blend is back.

## After the rebuild

```bash
export EVIDENCE_PHASE=post-reset                 # already set above; again for a new shell
pnpm pool-check --verify-only                    # post-reset D2.contract (also run by --run when it deployed the pool)
pnpm local:up && pnpm local:check
pnpm balance-check && pnpm drive-payment --cash-out && pnpm pool-check && pnpm concurrent-setups
pnpm archive-tx --phase post-reset
pnpm evidence-index --check && pnpm evidence-index
```

Post-reset evidence from the local stack is marked `origin: local`; the app.corra.money row stays
pending until the builder deploys (below).

## Keeping the pool alive

Soroban entries expire. `pnpm pool-ttl` (monthly, or when `pnpm ops-check` warns under 21 days) extends
the pool's shared entries and the position of every supplier recorded in the `pool_ops` table of the
`DATABASE_URL` database (default: the local stack, `localhost:5434`). The admin pays; a run is maintenance,
not a rebuild. Production suppliers are in `corra-db` on the host, which publishes no port: their positions
are extended only by a run against that database, for example through an SSH tunnel
(`ssh -L 5435:<corra-db container IP>:5432 root@46.225.47.201`, then `DATABASE_URL=postgres://corra:corra@localhost:5435/corra pnpm pool-ttl`).
A run against the local database alone extends the shared entries and local suppliers only.

## Production

Only with the builder's approval: [release-checklist.md](release-checklist.md), section 9.

## Rehearsal

From zero, on throwaway testnet keys, in a copy of the repo without its secrets (the real repo and
`.env.testnet` are never touched):

```bash
R=<scratch>/corra-rehearsal
rsync -a --exclude /.env.testnet --exclude /deploy/.secrets --exclude /infra/anchor/generated \
  --exclude /.local-stack --exclude /.git ~/Desktop/corra-public/ "$R/"
cd "$R" && pnpm seed-testnet --keys-only        # 6 fresh keys and their testnet.ts; nothing submitted
printf "// rehearsal\nimport type { BlendIds } from './types';\n\nexport const TESTNET_BLEND: BlendIds | null = null;\n" > packages/shared/src/testnet-blend.ts
pnpm redeploy-after-reset --run                  # creates everything
pnpm redeploy-after-reset --run                  # 0 transactions, files unchanged
pnpm onchain-check && pnpm pool-check --verify-only
```
