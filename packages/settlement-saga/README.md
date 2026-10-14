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

Storage, the chain and the payout handler are injected, so the module carries no database, framework or key.

## Reuse

This is not a standalone npm package. It depends on `@corra/shared` and `@corra/stellar`, which are
workspace packages in this repo, and it reads the corridor asset table in `@corra/shared` (the
`FIAT` table that maps a currency to its asset code). Another wallet reuses it by taking those
three packages and supplying its own `SagaStore`, `StellarGateway` (or `createHorizonGateway`)
and payout handler (`PayoutHandler`; `createMockPayout()` is the Phase 1 default).

## Lifting it into another wallet

```ts
import { createMockPayout, createSaga, InMemorySagaStore } from '@corra/settlement-saga';
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
  payout: createMockPayout(),              // or your own PayoutHandler; CREDITED waits for its acknowledgement
});

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
[docs/testing.md](../../docs/testing.md) (39 tests) against real signed XDRs and a fake chain.
