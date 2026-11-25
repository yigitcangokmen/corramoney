# Month-2 evidence (second SOW)

Everything here is public Stellar **testnet** data written by the scripts in this repo. EVIDENCE.md's
month-2 block is generated from this folder by `pnpm evidence-index`; edit `manual.json`, never the block.

## Layout

```
evidence/
  2026-10/tx/<hash>.json, tx/index.json        month 1, archived by pnpm archive-tx --from-md EVIDENCE.md
  2026-12/
    README.md                                  this file
    manual.json                                hand-entered items (screenshots, CI run, video, notes)
    pre-reset/   d1/ d2/ d3/ app/ tx/          before the testnet reset of 2026-12-16 17:00 UTC
    post-reset/  d1/ d2/ d3/ app/ tx/          after the rebuild (pnpm redeploy-after-reset)
```

`EVIDENCE_PHASE=pre-reset|post-reset` picks the phase for every writer (unset: pre-reset until 2026-12-16 17:00 UTC; from then on a writer refuses to run until it is set, and `evidence-index --check` reports a pre-reset file written after it). Each JSON
carries `phase`, `origin` (`prod` for https://api.corra.money, `local` for the local stack, `other`),
`orchestrator` and `writtenAt`; a JSON without `origin` (written before Unit 6) is local.

## Who writes what

| Folder | Script | File |
|---|---|---|
| `d1/` | `pnpm balance-check` | `balance-check-<time>.json`: deposit, five sends from the balance, the 409 in-progress probe |
| `d2/` | `pnpm deploy-pool`, `pnpm pool-check`, `pnpm pool-check --verify-only` | `deploy-pool-`, `pool-check-`, `pool-verify-<time>.json` |
| `d3/` | `pnpm drive-payment --cash-out`, `pnpm concurrent-setups` | `cash-out-<time>.json`, `more-info-<anchor id>.html` (token removed), `concurrent-setups-<time>.json` |
| `app/` | `pnpm evidence-app-run --account G... [--recipient G...] [--via-app]` | `app-run-<first 8 of account>-<time>.json`: a Freighter run, read from the public routes; `--via-app` marks a run done in the app on app.corra.money, the only app run that counts as D1.hosted (else D1.hosted is a manual.json entry with an app.corra.money screenshot) |
| `tx/` | `pnpm archive-tx --phase <phase> [--all]` | `<hash>.json` (Horizon transaction, operations, effects; RPC for Soroban), `index.json` |

Screenshots are named `<what>-<390|1440>.png` and listed in `manual.json`.

## Never here

- a `token` query parameter (the anchor's more_info link carries a session token: it is shown by a
  screenshot and the saved HTML with the token removed, never as a link);
- anything shaped like a secret seed (`S` and 55 base32 characters);
- a file over 2 MB, or any video;
- the walkthrough video's link: it is submitted privately. Its `manual.json` entry (`item: "video"`)
  takes only a note, no link, file or hash, and EVIDENCE.md shows "submitted privately (link not published)".

`pnpm evidence-index --check` fails on each of these.

## Re-run

```bash
EVIDENCE_PHASE=pre-reset pnpm archive-tx --phase pre-reset --all   # before 2026-12-16 17:00 UTC
pnpm evidence-index --check                                           # gaps, archive, claims, forbidden content
pnpm evidence-index                                                   # rewrite the EVIDENCE.md block
```
