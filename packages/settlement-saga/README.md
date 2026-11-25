# @corra/settlement-saga

The ordering piece Corra adds on top of Stellar: a non-custodial payment saga for the case where
the sender's value does not exist on chain until a third-party anchor confirms cash-in.

The sender signs a fully bound strict-receive path payment up front (sendMax cap, 30-minute
maxTime, minSeqNum window). The saga holds that signed blob, never a key, and submits it only
after the cash-in is confirmed from chain state. It can submit the blob or not; it cannot change
the recipient, the amount or the cap.

```
QUOTED -> SIGNED -> CASH_IN -> ONCHAIN -> CREDITED
             |          |          |-> CAP_EXCEEDED   (op_over_source_max, nothing moved)
             |          |          '-> FAILED         (landed failed for another reason)
             '----------'-> EXPIRED                    (maxTime passed, never entered a ledger)
```

## What it depends on

- `@corra/shared`: types (Money, Quote, Payment), the wire format and the corridor asset table
- `@corra/stellar`: the `StellarGateway` interface and the bound-transaction check

Storage and the chain are injected, so the module carries no database, framework or key.

## Kinds, deposits and cash-outs

- **Payment kinds.** `cash_in` is the flow above (sign first, the anchor deposit pays for it). `balance` pays from TESTMXN already in the sender's account: `confirm(..., { kind: 'balance' })` writes QUOTED -> SIGNED -> CASH_IN in one step and submits at once. One balance payment is in flight per sender (`409 PAYMENT_IN_PROGRESS`).
- **`CREDITED`** means the recipient's account holds the destination asset. The payment then carries a `cash_out` leg, `PENDING` until the recipient withdraws.
- **`createDeposits`** (`deposits.ts`): deposits into the sender's own account, tied to no payment. A `DepositStore` implements create, get, find by ref and by memo, list by account, a write-once client link, an anchor-proven bind, conditional confirm, short-credit, expire and touch, and `listOpenDeposits`. `CONFIRMED` only ever comes from a chain credit by the anchor's distribution account carrying the deposit's memo; the anchor's reference and callbacks only say where to look. Open deposits are checked by age (every 30 s while younger than 10 minutes, then every 2 minutes up to 2 hours, then every 10 minutes; expired ones hourly for 7 days), the one due longest first (due = last check + its interval, so no age class can starve another), at most 5 per pass (`DEPOSIT_CADENCE`, `MAX_CHECKS_PER_PASS`).
- **`createCashOuts`** (`cash-out.ts`): the recipient's SEP-24 withdrawal of a `CREDITED` payment, over the same store. The leg turns `CONFIRMED` only when the anchor's signed `completed` callback and the recipient's payment on chain agree.
- **Atomicity.** Every store method that changes a row does it conditionally in one step (`transition()`, `recordCashOut()`'s compare-and-set, `confirmDeposit()` only from a non-CONFIRMED row), so a duplicate callback and a concurrent reconciler are harmless.

## Reuse

This is not a standalone npm package. It depends on `@corra/shared` and `@corra/stellar`, which are
workspace packages in this repo, and it reads the corridor asset table in `@corra/shared` (the
`FIAT` table that maps a currency to its asset code). Another wallet reuses it by taking those
three packages and supplying its own `SagaStore` and `StellarGateway` (or `createHorizonGateway`).
A `SagaStore` also implements the cash-out methods: `recordCashOut` (a compare-and-set on the
cash_out leg's tx hash, explicit nulls clear, an event with `from = to = CREDITED`, never a state
change), `findPaymentByCashOutRef`, `listOpenCashOuts` and `touchCashOut`.

## Lifting it into another wallet

```ts
import { createCashOuts, createSaga, InMemorySagaStore } from '@corra/settlement-saga';
import { createHorizonGateway, createSponsor } from '@corra/stellar';

const saga = createSaga({
  store: new InMemorySagaStore(),          // or your own SagaStore (see services/orchestrator for Postgres)
  gateway: createHorizonGateway({
    horizonUrl,
    networkPassphrase,
    // the sponsor pays reserves only for trustlines to these corridor assets
    sponsor: createSponsor(feeSponsorSecret, networkPassphrase, { trustIssuer: corridorIssuer, trustCodes }),
  }),
  networkPassphrase,
  corridorIssuer,                          // issuer of your corridor assets
  anchorDistribution,                      // account your anchor pays deposits from
  anchorId: 'my-anchor',
});
// The recipient's SEP-24 withdrawal of a CREDITED payment: pass the saga's own store and gateway instances.
const cashOuts = createCashOuts({ store: sagaStore, gateway: sagaGateway, networkPassphrase, anchorId: 'my-anchor', anchorDistribution, asset: testphp });

const quote = await saga.quote({ corridor, destAmount });          // strict-receive route + sendMax
const payment = await saga.confirm(quote.id, { sender, recipient, signedXdr, idemKey });
await saga.linkCashIn(payment.id, sep24TransactionId);           // optional: lets the callback find it
await saga.onCashIn(verifiedSep24Callback);                       // a trigger, never an authority
setInterval(() => saga.reconcileAll(30_000), 10_000);            // recovers lost callbacks from chain state
```

Implement `SagaStore` for your database. Its one hard requirement: `transition()` must be atomic
(apply only if the payment is still in `from`, upsert legs, append the next event), which is what
makes duplicate callbacks and a concurrent reconciler harmless.

## Tests

`pnpm --filter @corra/settlement-saga test` runs the scenario matrix from
[docs/testing.md](../../docs/testing.md) against real signed XDRs and a fake chain; the counts are there.
