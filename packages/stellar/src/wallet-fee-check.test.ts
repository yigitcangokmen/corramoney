/**
 * The wallet rule the payment-account shape depends on, ported from Varial (the wallet formerly
 * named Freighter) 5.52.0, tag 5.52.0 = commit 2cde051f:
 *   - extension/src/popup/views/SignTransaction/index.tsx:387-418: the "INSUFFICIENT FUNDS FOR FEE"
 *     modal shows when `isSameAccount(getFeeSourceAccount(transaction), publicKey)` and
 *     `!hasEnoughXlmForFee(balances, stroopToXlm(_fee))`
 *   - extension/src/helpers/stellar.ts:249 getFeeSourceAccount: a fee-bump's feeSource, else tx.source
 *   - extension/src/helpers/stellar.ts:193 isSameAccount: both sides compared as base (G) accounts
 *   - extension/src/popup/helpers/balance.ts:343 hasEnoughXlmForFee: the native balance's
 *     `available.gt(fee)`, a strict greater-than
 * Upstream tests the same rule: SignTransaction.test.tsx:938 "does not show unfunded warning when
 * another account pays the fee". `publicKey` is the account the dapp asked to sign with (Corra
 * passes the sender). If any shape Corra asks the sender to sign regresses to a sender-sourced
 * envelope, the modal comes back and this test fails.
 */
import * as S from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { fromDecimal } from '@corra/shared';
import { buildCashOutPayment, buildPaymentAccountSetup, buildSponsoredSetup, buildStrictReceive, type StrictReceiveParams } from './build';
import { canonical, NP, NOW, PAYMENT_ACCOUNT, user } from '../test/pool-fixtures';

/** getBaseAccount: a muxed M address resolves to its G account. */
const baseAccount = (a: string) => (S.StrKey.isValidMed25519PublicKey(a) ? S.MuxedAccount.fromAddress(a, '0').baseAccount().accountId() : a);
const isSameAccount = (a?: string, b?: string) => !!a && !!b && baseAccount(a) === baseAccount(b);
const getFeeSourceAccount = (tx: S.Transaction | S.FeeBumpTransaction) => (tx instanceof S.FeeBumpTransaction ? tx.feeSource : tx.source);
/** Both in stroops: `available.gt(fee)` on the same unit. */
const hasEnoughXlmForFee = (availableStroops: bigint, feeStroops: bigint) => availableStroops > feeStroops;

/** True when Varial 5.52.0 shows the INSUFFICIENT FUNDS FOR FEE modal to `signer` holding `availableStroops`. */
function varialWarns(xdr: string, signer: string, availableStroops = 0n): boolean {
  const tx = S.TransactionBuilder.fromXDR(xdr, NP);
  const isFeeSource = isSameAccount(getFeeSourceAccount(tx), signer);
  const hasEnoughXlm = isFeeSource ? hasEnoughXlmForFee(availableStroops, BigInt(tx.fee)) : true;
  return !hasEnoughXlm;
}

const issuer = S.Keypair.random().publicKey();
const MXN = { code: 'TESTMXN', issuer };
const PHP = { code: 'TESTPHP', issuer };
const sponsor = S.Keypair.random().publicKey();
const sender = user.publicKey();
const z = S.Keypair.random().publicKey();

const payment = (mode: 'presigned' | 'balance', over: Partial<StrictReceiveParams> = {}) => buildStrictReceive({
  networkPassphrase: NP, sender, paymentAccount: z, paymentSequence: '5000', recipient: S.Keypair.random().publicKey(),
  dest: fromDecimal(PHP, '1000'), sendMax: fromDecimal(MXN, '334.2587991'), path: [], now: NOW, mode, ...over,
}).toXDR();

describe('wallet-fee-check: Varial 5.52.0 shows no fee modal to a 0-XLM sender on any shape Corra asks it to sign', () => {
  it('setup 4.1/4.2: the sender\'s own setup (sponsor is the source) and the payment-account setup', () => {
    for (const accountExists of [false, true]) {
      const own = buildSponsoredSetup({ networkPassphrase: NP, sponsor, sponsorSequence: '1', account: sender, accountExists, trust: [MXN], now: NOW });
      expect(varialWarns(own.toXDR(), sender)).toBe(false);
    }
    const pa = buildPaymentAccountSetup({ networkPassphrase: NP, sponsor, sponsorSequence: '1', sender, paymentAccount: z, now: NOW });
    expect(varialWarns(pa.toXDR(), sender)).toBe(false);
  });

  it('WF-C1 channel-sourced setups (Unit 5): the payment-account and account setups show no warning to a 0-XLM sender', () => {
    const txSource = { account: S.Keypair.random().publicKey(), sequence: '7000' };
    const pa = buildPaymentAccountSetup({ networkPassphrase: NP, sponsor, sponsorSequence: '1', txSource, sender, paymentAccount: z, now: NOW });
    const own = buildSponsoredSetup({ networkPassphrase: NP, sponsor, sponsorSequence: '1', txSource, account: sender, accountExists: false, trust: [MXN], now: NOW });
    expect(varialWarns(pa.toXDR(), sender)).toBe(false);
    expect(varialWarns(own.toXDR(), sender)).toBe(false);
  });

  it('pre-signed 4.3 and balance 4.4: the payment account is the fee source, not the sender', () => {
    expect(varialWarns(payment('presigned'), sender)).toBe(false);
    expect(varialWarns(payment('balance'), sender)).toBe(false);
  });

  it('pool submit 4.5: the payment account is the fee source, the sender only the operation source', () => {
    const xdr = canonical('supply');
    expect((S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction).source).toBe(PAYMENT_ACCOUNT);
    expect(varialWarns(xdr, sender)).toBe(false);
    expect(varialWarns(canonical('withdraw'), sender)).toBe(false);
  });

  it('the old Phase 1 shape (the sender as transaction source, fee 0) does warn: 0 > 0 is false', () => {
    expect(varialWarns(payment('presigned', { paymentAccount: sender }), sender)).toBe(true);
    expect(varialWarns(payment('balance', { paymentAccount: sender }), sender)).toBe(true);
    expect(varialWarns(canonical('supply', (d) => { d.txSource = d.source; }), sender)).toBe(true);
    // The rule is the fee source, not the amount: 1 stroop more than the fee would pass.
    expect(varialWarns(payment('balance', { paymentAccount: sender }), sender, 1n)).toBe(false);
  });

  it('cash-out (D3): the recipient\'s withdrawal sourced by its payment account does not warn; the same payment sourced by the recipient does', () => {
    const recipient = S.Keypair.random().publicKey();
    const cashOut = (paymentAccount: string) => buildCashOutPayment({
      networkPassphrase: NP, recipient, paymentAccount, paymentSequence: '7000', destination: S.Keypair.random().publicKey(),
      amount: fromDecimal(PHP, '1000'), memo: { type: 'id', value: '42' }, now: NOW,
    }).toXDR();
    expect(varialWarns(cashOut(z), recipient)).toBe(false);
    expect(varialWarns(cashOut(recipient), recipient)).toBe(true);
  });
});
