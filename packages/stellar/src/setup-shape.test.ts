/**
 * assertSetupShape: the one set of setup rules the sponsor and the channel accounts both sign under.
 * CI step "Channel key refusals" runs this file and channels.test.ts.
 */
import * as S from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { buildPaymentAccountSetup, buildSponsoredSetup } from './build';
import { assertSetupShape, SetupShapeError, type SetupShapeScope } from './setup-shape';

const NP = S.Networks.TESTNET;
const NOW = 1_800_000_000;
const issuer = S.Keypair.random().publicKey();
const MXN = { code: 'TESTMXN', issuer };
const SP = S.Keypair.random().publicKey();
const C = S.Keypair.random().publicKey();
const C2 = S.Keypair.random().publicKey();
const P = S.Keypair.random().publicKey();
const Z = S.Keypair.random().publicKey();

const scope = (o: Partial<SetupShapeScope> = {}): SetupShapeScope => ({
  sponsor: SP, txSources: [SP], channels: [C, C2], trustIssuer: issuer, trustCodes: ['TESTMXN', 'TESTPHP'], maxTrust: 2,
  requireCreateAccount: false, nowSec: NOW, ...o,
});
const parse = (xdr: string) => S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
const own = (o: { exists?: boolean; source?: string } = {}) => buildSponsoredSetup({
  networkPassphrase: NP, sponsor: SP, sponsorSequence: '10', ...(o.source ? { txSource: { account: o.source, sequence: '70' } } : {}),
  account: P, accountExists: o.exists ?? false, trust: [MXN], now: NOW,
});
const pa = (source?: string) => buildPaymentAccountSetup({
  networkPassphrase: NP, sponsor: SP, sponsorSequence: '10', ...(source ? { txSource: { account: source, sequence: '70' } } : {}),
  sender: P, paymentAccount: Z, now: NOW,
});

/** The new-account sandwich for `id`, with TESTMXN. */
const newAccountOps = (id: string) => [
  S.Operation.beginSponsoringFutureReserves({ sponsoredId: id, source: SP }),
  S.Operation.createAccount({ destination: id, startingBalance: '0', source: SP }),
  S.Operation.changeTrust({ asset: new S.Asset(MXN.code, issuer), source: id }),
  S.Operation.endSponsoringFutureReserves({ source: id }),
];

type Pre = { minTime: number; ledgerbounds: { minLedger: number; maxLedger: number }; minAccountSequence: string;
  minAccountSequenceAge: bigint; minAccountSequenceLedgerGap: number; extraSigners: string[]; memo: S.Memo };
/** The canonical new-account setup from the sponsor, with one precondition or a memo added. */
function withPre(p: Partial<Pre>) {
  const b = new S.TransactionBuilder(new S.Account(SP, '10'), {
    fee: '1000', networkPassphrase: NP, timebounds: { minTime: p.minTime ?? 0, maxTime: NOW + 300 },
    ...(p.ledgerbounds ? { ledgerbounds: p.ledgerbounds } : {}),
    ...(p.minAccountSequence ? { minAccountSequence: p.minAccountSequence } : {}),
    ...(p.minAccountSequenceAge ? { minAccountSequenceAge: p.minAccountSequenceAge } : {}),
    ...(p.minAccountSequenceLedgerGap ? { minAccountSequenceLedgerGap: p.minAccountSequenceLedgerGap } : {}),
    ...(p.extraSigners ? { extraSigners: p.extraSigners } : {}),
    ...(p.memo ? { memo: p.memo } : {}),
  });
  for (const op of newAccountOps(P)) b.addOperation(op);
  return b.build();
}
/** A setup with these operations, sourced by `source`. */
function opsTx(source: string, ops: S.xdr.Operation[]) {
  const b = new S.TransactionBuilder(new S.Account(source, '70'), { fee: '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 300 } });
  for (const op of ops) b.addOperation(op);
  return b.build();
}
const refuse = (tx: S.Transaction, s: SetupShapeScope, reason: RegExp) => {
  expect(() => assertSetupShape(tx, s), String(reason)).toThrow(SetupShapeError);
  expect(() => assertSetupShape(tx, s), String(reason)).toThrow(reason);
};

describe('assertSetupShape', () => {
  it('SS1 accepts the sponsor-sourced account setup (new and trustline-only) and the payment-account setup', () => {
    expect(assertSetupShape(own(), scope())).toEqual({ kind: 'account', sponsored: P, createsAccount: true });
    expect(assertSetupShape(own({ exists: true }), scope())).toEqual({ kind: 'account', sponsored: P, createsAccount: false });
    expect(assertSetupShape(pa(), scope())).toEqual({ kind: 'paymentAccount', sponsored: Z, createsAccount: true });
  });

  it('SS2 accepts the same with a channel as transaction source when txSources = [channel]', () => {
    const s = scope({ txSources: [C], requireCreateAccount: true });
    expect(assertSetupShape(own({ source: C }), s)).toMatchObject({ kind: 'account', createsAccount: true });
    expect(assertSetupShape(pa(C), s)).toMatchObject({ kind: 'paymentAccount', createsAccount: true });
    expect(own({ source: C }).source).toBe(C);
  });

  it('SS3 R-S1 refuses a transaction source outside txSources', () => {
    refuse(own({ source: C }), scope(), /sourced by the sponsor or a channel account/);
    refuse(own(), scope({ txSources: [C] }), /sourced by the sponsor or a channel account/);
  });

  it('SS4 R-S5 refuses each other precondition', () => {
    const cases: Partial<Pre>[] = [
      { minTime: 1 }, { ledgerbounds: { minLedger: 0, maxLedger: 100 } }, { minAccountSequence: '5' },
      { minAccountSequenceAge: 1n }, { minAccountSequenceLedgerGap: 1 }, { extraSigners: [S.Keypair.random().publicKey()] },
    ];
    expect(() => assertSetupShape(withPre({}), scope())).not.toThrow();
    for (const c of cases) refuse(withPre(c), scope(), /no other precondition/);
  });

  it('SS5 R-S6 refuses a text memo', () => {
    refuse(withPre({ memo: S.Memo.text('hi') }), scope(), /carries no memo/);
  });

  it('SS6 R-ACC-6 refuses a channel or the transaction source as the account set up', () => {
    refuse(opsTx(SP, newAccountOps(C)), scope(), /a channel account cannot be set up/);
    const stranger = S.Keypair.random().publicKey();
    refuse(opsTx(stranger, newAccountOps(stranger)), scope({ txSources: [stranger] }), /a channel account cannot be set up/);
  });

  it('SS7 R-P refuses a channel as payment account or as its signer, and the transaction source as its signer', () => {
    const paOps = (z: string, signer: string) => [
      S.Operation.beginSponsoringFutureReserves({ sponsoredId: z, source: SP }),
      S.Operation.createAccount({ destination: z, startingBalance: '0', source: SP }),
      S.Operation.setOptions({ source: z, masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1, signer: { ed25519PublicKey: signer, weight: 1 } }),
      S.Operation.endSponsoringFutureReserves({ source: z }),
    ];
    const s = scope({ txSources: [SP, C] });
    refuse(opsTx(SP, paOps(C, P)), s, /a channel account cannot be set up or be a signer/);
    refuse(opsTx(SP, paOps(Z, C2)), s, /a channel account cannot be set up or be a signer/);
    const X = S.Keypair.random().publicKey(); // not a channel: the rule is the transaction source itself
    refuse(opsTx(X, paOps(Z, X)), scope({ txSources: [X] }), /a channel account cannot be set up or be a signer/);
    expect(() => assertSetupShape(opsTx(C, paOps(Z, P)), s)).not.toThrow();
  });

  it('SS8 R-C refuses a trustline-only setup when a created account is required, and accepts it otherwise', () => {
    refuse(own({ exists: true }), scope({ requireCreateAccount: true }), /signs only a setup that creates a new account/);
    expect(() => assertSetupShape(own({ exists: true }), scope({ requireCreateAccount: false }))).not.toThrow();
  });
});
