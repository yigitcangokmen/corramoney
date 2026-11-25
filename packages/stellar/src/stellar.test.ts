import * as S from '@stellar/stellar-sdk';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { fromDecimal, toDecimal } from '@corra/shared';
import {
  BALANCE_TTL_SEC, buildCashOutPayment, buildFeeBump, buildPaymentAccountSetup, buildSponsoredSetup, buildStrictReceive, CASH_OUT_TTL_SEC,
  PAYMENT_TTL_SEC, SEQ_WINDOW, toSdkMemo, type CashOutMemo,
} from './build';
import {
  assertBoundPayment, assertCashOutPayment, cashOutFactsOf, sameMemo, signedSequence, signedSourceAccount, UnboundTransactionError,
  type ExpectedPayment,
} from './validate';
import { assertPaymentAccountSetup, isPaymentAccount, type AccountRecordLike } from './payment-account';
import { createSponsor, SponsorRefusal } from './sponsor';
import { classifySubmitError } from './submit';
import { createHorizonGateway } from './gateway';

const NP = S.Networks.TESTNET;
const NOW = 1_800_000_000;
const issuer = S.Keypair.random().publicKey();
const MXN = { code: 'TESTMXN', issuer };
const PHP = { code: 'TESTPHP', issuer };
const USDC = { code: 'USDC', issuer: S.Keypair.random().publicKey() };

const sender = S.Keypair.random();
/** The sender's payment account: the transaction source of every payment (spec-varial-fix 4.3/4.4). */
const PAY = S.Keypair.random().publicKey();
const recipient = S.Keypair.random().publicKey();
const sponsorKey = S.Keypair.random();
const sponsor = createSponsor(sponsorKey.secret(), NP, { trustIssuer: issuer, trustCodes: ['TESTMXN', 'TESTPHP'] });
const signAt = (xdr: string) => sponsor.signSetup(xdr, NOW);

const expected: ExpectedPayment = {
  sender: sender.publicKey(),
  paymentAccount: PAY,
  recipient,
  dest: fromDecimal(PHP, '1000'),
  sendMax: fromDecimal(MXN, '334.2587991'),
  path: [USDC],
};

function signedPayment(overrides: Partial<Parameters<typeof buildStrictReceive>[0]> = {}, signer = sender) {
  const tx = buildStrictReceive({
    networkPassphrase: NP,
    sender: expected.sender,
    paymentAccount: PAY, paymentSequence: '5000',
    recipient: expected.recipient,
    dest: expected.dest,
    sendMax: expected.sendMax,
    path: expected.path,
    now: NOW,
    ...overrides,
  });
  tx.sign(signer);
  return tx.toXDR();
}

const reject = (xdr: string, reason: RegExp, exp = expected) =>
  expect(() => assertBoundPayment(xdr, exp, NP, NOW)).toThrow(reason);

describe('buildStrictReceive', () => {
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: expected.sender, paymentAccount: PAY, paymentSequence: '5000', recipient,
    dest: expected.dest, sendMax: expected.sendMax, path: expected.path, now: NOW,
  });

  it('stays valid across a sequence window instead of one exact value (CAP-21)', () => {
    expect(tx.minAccountSequence).toBe('5000');
    expect(BigInt(tx.sequence)).toBe(5000n + SEQ_WINDOW);
  });

  it('dies 30 minutes after signing and costs the sender no fee', () => {
    expect(Number(tx.timeBounds!.maxTime)).toBe(NOW + PAYMENT_TTL_SEC);
    expect(tx.fee).toBe('0');
  });
});

describe('assertBoundPayment', () => {
  it('accepts exactly the quoted payment signed by the sender', () => {
    const r = assertBoundPayment(signedPayment(), expected, NP, NOW);
    expect(r.minSequence).toBe('5000');
    expect(r.maxTime).toBe(NOW + PAYMENT_TTL_SEC);
  });

  it('refuses an unsigned or foreign-signed blob', () => {
    const unsigned = buildStrictReceive({
      networkPassphrase: NP, sender: expected.sender, paymentAccount: PAY, paymentSequence: '5000', recipient,
      dest: expected.dest, sendMax: expected.sendMax, path: expected.path, now: NOW,
    }).toXDR();
    reject(unsigned, /not signed by the sender/);
    reject(signedPayment({}, S.Keypair.random()), /not signed by the sender/);
  });

  it('refuses any field that differs from the quote', () => {
    reject(signedPayment({ recipient: S.Keypair.random().publicKey() }), /destination mismatch/);
    reject(signedPayment({ dest: fromDecimal(PHP, '1000.0000001') }), /destination amount/);
    reject(signedPayment({ sendMax: fromDecimal(MXN, '999') }), /sendMax mismatch/);
    reject(signedPayment({ path: [] }), /path mismatch/);
    reject(signedPayment({ dest: fromDecimal(USDC, '1000') }), /destination asset/);
  });

  it('refuses expired or over-long timebounds', () => {
    reject(signedPayment({ now: NOW - PAYMENT_TTL_SEC - 1 }), /already expired/);
    reject(signedPayment({ ttlSec: 24 * 3600 }), /beyond the allowed window/);
    reject(signedPayment({ ttlSec: 3 }), /too close/);
  });

  it('refuses a transaction without minSeqNum or with extra operations', () => {
    const plain = new S.TransactionBuilder(new S.Account(PAY, '5099'), {
      fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 600 },
    }).addOperation(S.Operation.pathPaymentStrictReceive({
      sendAsset: new S.Asset(MXN.code, issuer), sendMax: '334.2587991', destination: recipient,
      destAsset: new S.Asset(PHP.code, issuer), destAmount: '1000', path: [new S.Asset(USDC.code, USDC.issuer)],
      source: expected.sender,
    })).build();
    plain.sign(sender);
    reject(plain.toXDR(), /no minSeqNum/);

    const two = new S.TransactionBuilder(new S.Account(PAY, '5099'), {
      fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 600 }, minAccountSequence: '5000',
    })
      .addOperation(S.Operation.bumpSequence({ bumpTo: '1' }))
      .addOperation(S.Operation.bumpSequence({ bumpTo: '2' }))
      .build();
    two.sign(sender);
    reject(two.toXDR(), /exactly one operation/);
  });

  it('refuses garbage and fee-bump envelopes', () => {
    reject('not-xdr', /not a transaction envelope/);
    reject(sponsor.feeBump(signedPayment()), /fee-bump envelopes/);
  });

  it('is a typed error the API can map to 422', () => {
    try { assertBoundPayment('x', expected, NP, NOW); } catch (e) { expect(e).toBeInstanceOf(UnboundTransactionError); }
  });
});

describe('sponsor key scope', () => {
  it('fee-bumps a sender-signed payment and is the only extra signer', () => {
    const bump = S.TransactionBuilder.fromXDR(sponsor.feeBump(signedPayment()), NP) as S.FeeBumpTransaction;
    expect(bump).toBeInstanceOf(S.FeeBumpTransaction);
    expect(bump.feeSource).toBe(sponsorKey.publicKey());
    expect(bump.signatures).toHaveLength(1);
    expect(bump.innerTransaction.signatures).toHaveLength(1);
  });

  it('refuses to fee-bump anything that touches the sponsor account', () => {
    const asSource = buildStrictReceive({
      networkPassphrase: NP, sender: expected.sender, paymentAccount: sponsorKey.publicKey(), paymentSequence: '1', recipient,
      dest: expected.dest, sendMax: expected.sendMax, path: expected.path, now: NOW,
    }).toXDR();
    expect(() => sponsor.feeBump(asSource)).toThrow(SponsorRefusal);
    expect(() => sponsor.feeBump(signedPayment({ recipient: sponsorKey.publicKey() }))).toThrow(/cannot receive value/);
  });

  const setup = (accountExists: boolean) =>
    buildSponsoredSetup({
      networkPassphrase: NP, sponsor: sponsorKey.publicKey(), sponsorSequence: '10',
      account: sender.publicKey(), accountExists, trust: [MXN], now: NOW,
    });

  it('signs a sponsorship sandwich for new and existing accounts', () => {
    for (const exists of [false, true]) {
      const signed = S.TransactionBuilder.fromXDR(sponsor.signSetup(setup(exists).toXDR(), NOW), NP) as S.Transaction;
      expect(signed.signatures).toHaveLength(1);
      expect(signed.operations.map((o) => o.type)).toEqual(
        exists
          ? ['beginSponsoringFutureReserves', 'changeTrust', 'endSponsoringFutureReserves']
          : ['beginSponsoringFutureReserves', 'createAccount', 'changeTrust', 'endSponsoringFutureReserves'],
      );
    }
  });

  it('refuses a setup that funds the account, moves value, or skips closing the sandwich', () => {
    const base = (ops: (b: S.TransactionBuilder) => S.TransactionBuilder) =>
      ops(new S.TransactionBuilder(new S.Account(sponsorKey.publicKey(), '10'), {
        fee: '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 300 },
      }).addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: sender.publicKey(), source: sponsorKey.publicKey() })))
        .build().toXDR();
    const end = S.Operation.endSponsoringFutureReserves({ source: sender.publicKey() });

    expect(() => signAt(base((b) => b
      .addOperation(S.Operation.createAccount({ destination: sender.publicKey(), startingBalance: '5', source: sponsorKey.publicKey() }))
      .addOperation(end)))).toThrow(/0 XLM/);
    expect(() => signAt(base((b) => b
      .addOperation(S.Operation.payment({ destination: sender.publicKey(), asset: S.Asset.native(), amount: '1', source: sponsorKey.publicKey() }))
      .addOperation(end)))).toThrow(/not allowed/);
    expect(() => signAt(base((b) => b
      .addOperation(S.Operation.changeTrust({ asset: new S.Asset(MXN.code, issuer), source: sender.publicKey() }))))).toThrow(/close/);
  });
});

describe('classifySubmitError', () => {
  const err = (transaction: string, operations: string[] = [], inner?: string) =>
    ({ extras: { hash: 'h', result_codes: { transaction, inner_transaction: inner, operations } } });

  it('maps Horizon result codes to saga outcomes', () => {
    expect(classifySubmitError(err('tx_fee_bump_inner_failed', ['op_over_source_max'], 'tx_failed')).kind).toBe('cap_exceeded');
    expect(classifySubmitError(err('tx_fee_bump_inner_failed', [], 'tx_too_late')).kind).toBe('expired');
    expect(classifySubmitError(err('tx_too_late')).kind).toBe('expired');
    expect(classifySubmitError(err('tx_bad_seq')).kind).toBe('bad_seq');
    expect(classifySubmitError(err('tx_failed', ['op_no_trust'])).kind).toBe('failed');
  });

  it('a payment account that is gone (merged) is as dead as a used sequence', () => {
    expect(classifySubmitError(err('tx_fee_bump_inner_failed', [], 'tx_no_account')).kind).toBe('bad_seq');
  });
});

describe('assertBoundPayment pins every precondition (audit regressions)', () => {
  const variant = (o: Record<string, unknown>, extraSigner?: S.Keypair, seqOverride?: string) => {
    const tx = new S.TransactionBuilder(new S.Account(PAY, seqOverride ?? '5099'), {
      fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 600 }, minAccountSequence: '5000', ...o,
    }).addOperation(S.Operation.pathPaymentStrictReceive({
      sendAsset: new S.Asset(MXN.code, issuer), sendMax: '334.2587991', destination: recipient,
      destAsset: new S.Asset(PHP.code, issuer), destAmount: '1000', path: [new S.Asset(USDC.code, USDC.issuer)],
      source: expected.sender,
    })).build();
    tx.sign(sender);
    if (extraSigner) tx.sign(extraSigner);
    return tx.toXDR();
  };

  it('accepts the canonical shape built by buildStrictReceive', () => {
    expect(() => assertBoundPayment(variant({}), expected, NP, NOW)).not.toThrow();
  });

  it('refuses extra signers, ledger bounds, sequence age or gap, memos, fees, extra signatures and a wrong window', () => {
    reject(variant({ extraSigners: [S.Keypair.random().publicKey()] }), /preconditions/);
    reject(variant({ ledgerbounds: { minLedger: 1, maxLedger: 2 } }), /preconditions/);
    reject(variant({ minAccountSequenceAge: 5 }), /preconditions/);
    reject(variant({ minAccountSequenceLedgerGap: 3 }), /preconditions/);
    reject(variant({ memo: S.Memo.text('x') }), /memo/);
    reject(variant({ fee: '100' }), /fee/);
    reject(variant({}, S.Keypair.random()), /exactly one signature/);
    reject(variant({}, undefined, '6000'), /sequence window/);
    reject(variant({ timebounds: { minTime: NOW + 60, maxTime: NOW + 600 } }), /minTime must be 0/);
  });
});

describe('sponsor setup scope (audit regressions)', () => {
  const strict = createSponsor(sponsorKey.secret(), NP, { trustIssuer: issuer, trustCodes: ['TESTMXN', 'TESTPHP'] });
  const setupWith = (trust: { code: string; issuer: string }[], opts: { fee?: string; maxTime?: number } = {}) => {
    const b = new S.TransactionBuilder(new S.Account(sponsorKey.publicKey(), '10'), {
      fee: opts.fee ?? '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: opts.maxTime ?? NOW + 300 },
    }).addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: sender.publicKey(), source: sponsorKey.publicKey() }))
      .addOperation(S.Operation.createAccount({ destination: sender.publicKey(), startingBalance: '0', source: sponsorKey.publicKey() }));
    for (const a of trust) b.addOperation(S.Operation.changeTrust({ asset: new S.Asset(a.code, a.issuer), source: sender.publicKey() }));
    return b.addOperation(S.Operation.endSponsoringFutureReserves({ source: sender.publicKey() })).build().toXDR();
  };

  it('signs a setup for one allowed corridor asset', () => {
    expect(() => strict.signSetup(setupWith([{ code: 'TESTMXN', issuer }]), NOW)).not.toThrow();
  });

  it('refuses duplicates, foreign assets, too many trustlines, a high fee and an open-ended or past time bound', () => {
    expect(() => strict.signSetup(setupWith([MXN, MXN]), NOW)).toThrow(/duplicate/);
    expect(() => strict.signSetup(setupWith([{ code: 'TESTMXN', issuer: S.Keypair.random().publicKey() }]), NOW)).toThrow(/not allowed/);
    expect(() => strict.signSetup(setupWith([{ code: 'USDC', issuer }]), NOW)).toThrow(/not allowed/);
    expect(() => strict.signSetup(setupWith([MXN, PHP, { code: 'TESTBRL', issuer }]), NOW)).toThrow();
    expect(() => strict.signSetup(setupWith([MXN], { fee: '4294967294' }), NOW)).toThrow(/fee/);
    expect(() => strict.signSetup(setupWith([MXN], { maxTime: 0 }), NOW)).toThrow(/time bound/);
    expect(() => strict.signSetup(setupWith([MXN], { maxTime: NOW + 3600 }), NOW)).toThrow(/time bound/);
  });
});

describe('findDeposit (audit regressions)', () => {
  it('adds up every credit carrying the memo, so a short deposit can be topped up', async () => {
    const anchor = S.Keypair.random().publicKey();
    const account = S.Keypair.random().publicKey();
    const at = (s: number) => new Date(Date.UTC(2027, 0, 1, 0, 0, s)).toISOString();
    const credit = (hash: string, amount: string, memo: string, s: number) => ({
      type: 'payment', from: anchor, to: account, asset_code: MXN.code, asset_issuer: issuer, amount,
      created_at: at(s), transaction_hash: hash, transaction_successful: true,
      transaction_attr: { memo_type: 'hash', memo },
    });
    const records = [
      credit('top-up', '1.0000000', 'mine', 30),
      credit('other', '500.0000000', 'theirs', 20),
      credit('short', '333.2587991', 'mine', 10),
    ];
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ _links: { next: { href: '' } }, _embedded: { records } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const gw = createHorizonGateway({
        horizonUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, networkPassphrase: NP, sponsor,
      });
      const since = Date.parse(at(0));
      const mine = await gw.findDeposit({ account, from: anchor, asset: MXN, since, memo: 'mine' });
      expect(mine && toDecimal(mine.amount)).toBe('334.2587991');
      expect(mine?.hash).toBe('top-up');
      const any = await gw.findDeposit({ account, from: anchor, asset: MXN, since });
      expect(any?.hash).toBe('short');
    } finally {
      server.close();
    }
  });

  it('pages back past dust payments to find a deposit that is no longer on the first page', async () => {
    const anchor = S.Keypair.random().publicKey();
    const account = S.Keypair.random().publicKey();
    const spammer = S.Keypair.random().publicKey();
    const at = (s: number) => new Date(Date.UTC(2027, 0, 1, 0, 0, s)).toISOString();
    const dust = Array.from({ length: 200 }, (_, i) => ({
      type: 'payment', from: spammer, to: account, asset_type: 'native', amount: '0.0000001',
      created_at: at(1000 - i), transaction_hash: `dust-${i}`, transaction_successful: true,
      transaction_attr: { memo_type: 'none' },
    }));
    const deposit = {
      type: 'payment', from: anchor, to: account, asset_code: MXN.code, asset_issuer: issuer, amount: '334.2600000',
      created_at: at(10), transaction_hash: 'deposit', transaction_successful: true,
      transaction_attr: { memo_type: 'hash', memo: 'mine' },
    };
    let base = '';
    const server = createServer((req, res) => {
      const second = new URL(req.url!, base).searchParams.get('cursor') === 'page2';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        _links: { next: { href: second ? '' : `${base}/accounts/${account}/payments?cursor=page2&limit=200&order=desc&join=transactions` } },
        _embedded: { records: second ? [deposit] : dust },
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const gw = createHorizonGateway({ horizonUrl: base, networkPassphrase: NP, sponsor });
      const dep = await gw.findDeposit({ account, from: anchor, asset: MXN, since: Date.parse(at(0)), memo: 'mine' });
      expect(dep?.hash).toBe('deposit');
    } finally {
      server.close();
    }
  });
});

describe('fee-bump bid (audit follow-ups)', () => {
  it('the sponsor refuses a bid above its cap', () => {
    expect(() => sponsor.feeBump(signedPayment(), 50_000)).toThrow(/fee-bump bid/);
    const bump = S.TransactionBuilder.fromXDR(sponsor.feeBump(signedPayment(), 5_000), NP) as S.FeeBumpTransaction;
    expect(bump.fee).toBe('10000'); // 5000 per operation, inner op + the bump
  });

  async function submittedFee(baseFee: string, capacity = '0.1') {
    let posted = '';
    let base = '';
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url!.startsWith('/fee_stats')) return res.end(JSON.stringify({
          last_ledger_base_fee: baseFee, ledger_capacity_usage: capacity, fee_charged: { p90: '128054' } }));
        // The SDK's SEP-29 memo check loads the destination first; unknown accounts need no memo.
        if (req.url!.startsWith('/accounts/')) { res.statusCode = 404; return res.end('{}'); }
        posted = decodeURIComponent(new URLSearchParams(body).get('tx') ?? '');
        // Reject it: this test only needs the envelope Corra built, not a landed transaction.
        res.statusCode = 400;
        res.end(JSON.stringify({ extras: { result_codes: { transaction: 'tx_bad_seq' } } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const gw = createHorizonGateway({ horizonUrl: base, networkPassphrase: NP, sponsor });
      await gw.submitPayment(signedPayment());
      return (S.TransactionBuilder.fromXDR(posted, NP) as S.FeeBumpTransaction).fee;
    } finally {
      server.close();
    }
  }

  it('follows the inclusion base fee, not Soroban-inflated fee_charged, within the cap', async () => {
    expect(await submittedFee('100')).toBe('2000');          // quiet: the default 1000 per op, despite p90 128054
    expect(await submittedFee('7000')).toBe('14000');        // surge: follows the base fee
    expect(await submittedFee('7000', '0.95')).toBe('28000'); // full ledgers: twice the base fee
    expect(await submittedFee('9999999')).toBe('40000');     // never above the cap
  });
});


describe('balance mode (D1)', () => {
  const params = {
    networkPassphrase: NP, sender: expected.sender, paymentAccount: PAY, paymentSequence: '5000', recipient,
    dest: expected.dest, sendMax: expected.sendMax, path: expected.path, now: NOW,
  };
  const balanceTx = (o: Record<string, unknown> = {}, signers: S.Keypair[] = [sender]) => {
    const tx = buildStrictReceive({ ...params, mode: 'balance', ...o });
    for (const k of signers) tx.sign(k);
    return tx.toXDR();
  };
  const rejectBalance = (xdr: string, reason: RegExp, exp = expected) =>
    expect(() => assertBoundPayment(xdr, exp, NP, NOW, 'balance')).toThrow(reason);

  /** A balance-shaped transaction with one thing changed. */
  const variant = (o: Record<string, unknown>, ops?: S.xdr.Operation[], extraSigner?: S.Keypair) => {
    const b = new S.TransactionBuilder(new S.Account(PAY, '5000'), {
      fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + BALANCE_TTL_SEC }, ...o,
    });
    for (const op of ops ?? [S.Operation.pathPaymentStrictReceive({
      sendAsset: new S.Asset(MXN.code, issuer), sendMax: '334.2587991', destination: recipient,
      destAsset: new S.Asset(PHP.code, issuer), destAmount: '1000', path: [new S.Asset(USDC.code, USDC.issuer)],
      source: expected.sender,
    })]) b.addOperation(op);
    const tx = b.build();
    tx.sign(sender);
    if (extraSigner) tx.sign(extraSigner);
    return tx.toXDR();
  };

  it("builds the payment account's next transaction: seq current+1, no minSeqNum, a 5-minute TTL, fee 0, no memo, one op", () => {
    const tx = buildStrictReceive({ ...params, mode: 'balance' });
    expect(tx.sequence).toBe('5001');
    expect(tx.minAccountSequence).toBeUndefined();
    expect(Number(tx.timeBounds!.maxTime)).toBe(NOW + BALANCE_TTL_SEC);
    expect(tx.fee).toBe('0');
    expect(tx.memo.type).toBe('none');
    expect(tx.operations.map((o) => o.type)).toEqual(['pathPaymentStrictReceive']);
  });

  it('leaves the presigned build unchanged', () => {
    expect(buildStrictReceive({ ...params, mode: 'presigned' }).toXDR()).toBe(buildStrictReceive(params).toXDR());
  });

  it('accepts the canonical balance blob', () => {
    const r = assertBoundPayment(balanceTx(), expected, NP, NOW, 'balance');
    expect(r).toMatchObject({ maxTime: NOW + BALANCE_TTL_SEC, sequence: '5001' });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.minSequence).toBeUndefined();
  });

  it('refuses a Phase 1 blob, a too long and an expired timebound', () => {
    rejectBalance(signedPayment(), /beyond/); // a default Phase 1 blob dies on its 30-minute window first
    rejectBalance(signedPayment({ ttlSec: BALANCE_TTL_SEC }), /minSeqNum is not allowed/);
    rejectBalance(balanceTx({ ttlSec: BALANCE_TTL_SEC + 61 }), /beyond/);
    rejectBalance(balanceTx({ now: NOW - BALANCE_TTL_SEC }), /expired/);
    expect(() => assertBoundPayment(balanceTx({ ttlSec: BALANCE_TTL_SEC + 60 }), expected, NP, NOW, 'balance')).not.toThrow();
  });

  it('keeps every Phase 1 refusal', () => {
    const bump = (n: string) => S.Operation.bumpSequence({ bumpTo: n });
    const cases: [string, RegExp][] = [
      [variant({ fee: '100' }), /fee/],
      [variant({ memo: S.Memo.text('x') }), /memo/],
      [variant({}, undefined, S.Keypair.random()), /exactly one signature/],
      [balanceTx({}, [S.Keypair.random()]), /not signed by the sender/],
      [variant({}, [bump('1'), bump('2')]), /exactly one operation/],
      [variant({}, [S.Operation.pathPaymentStrictReceive({
        sendAsset: new S.Asset(MXN.code, issuer), sendMax: '334.2587991', destination: recipient,
        destAsset: new S.Asset(PHP.code, issuer), destAmount: '1000', path: [new S.Asset(USDC.code, USDC.issuer)],
        source: S.Keypair.random().publicKey(),
      })]), /operation source/],
      [balanceTx({ recipient: S.Keypair.random().publicKey() }), /destination mismatch/],
      [balanceTx({ dest: fromDecimal(PHP, '1000.0000001') }), /destination amount/],
      [balanceTx({ sendMax: fromDecimal(MXN, '999') }), /sendMax mismatch/],
      [balanceTx({ path: [] }), /path mismatch/],
      [sponsor.feeBump(balanceTx()), /fee-bump envelopes/],
      [variant({ extraSigners: [S.Keypair.random().publicKey()] }), /preconditions/],
      [variant({ ledgerbounds: { minLedger: 1, maxLedger: 2 } }), /preconditions/],
      [variant({ minAccountSequenceAge: 5 }), /preconditions/],
      [variant({ minAccountSequenceLedgerGap: 3 }), /preconditions/],
      [variant({ timebounds: { minTime: NOW + 60, maxTime: NOW + BALANCE_TTL_SEC } }), /minTime must be 0/],
    ];
    for (const [xdr, reason] of cases) rejectBalance(xdr, reason);
    expect(() => assertBoundPayment(variant({}), expected, NP, NOW, 'balance')).not.toThrow();
  });

  it('presigned mode refuses a balance blob', () => {
    reject(balanceTx(), /too close/);
    reject(balanceTx({ ttlSec: PAYMENT_TTL_SEC }), /no minSeqNum/);
  });

  it('the unchanged sponsor fee-bumps a balance blob', () => {
    const bump = S.TransactionBuilder.fromXDR(sponsor.feeBump(balanceTx()), NP) as S.FeeBumpTransaction;
    expect(bump.feeSource).toBe(sponsorKey.publicKey());
    expect(bump.innerTransaction.sequence).toBe('5001');
  });
});

describe('accountBalance and memoHash (D1)', () => {
  async function horizonWith(routes: Record<string, { status?: number; body: unknown }>) {
    const server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://x').pathname;
      const r = routes[path];
      res.setHeader('content-type', 'application/json');
      res.statusCode = r ? (r.status ?? 200) : 404;
      res.end(JSON.stringify(r ? r.body : { status: 404 }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const gw = createHorizonGateway({ horizonUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, networkPassphrase: NP, sponsor });
    return { gw, close: () => server.close() };
  }
  const account = (id: string, balances: unknown[]) => ({
    id, account_id: id, sequence: '123', subentry_count: 1, thresholds: {}, flags: {}, signers: [], data: {}, balances,
    _links: {},
  });

  it('returns the spendable amount (balance minus selling liabilities), null without the account or the trustline', async () => {
    const a = S.Keypair.random().publicKey();
    const b = S.Keypair.random().publicKey();
    const { gw, close } = await horizonWith({
      [`/accounts/${a}`]: { body: account(a, [
        { asset_type: 'native', balance: '5.0000000' },
        { asset_type: 'credit_alphanum12', asset_code: MXN.code, asset_issuer: issuer, balance: '100.0000000', selling_liabilities: '30.0000000' },
      ]) },
      [`/accounts/${b}`]: { body: account(b, [
        { asset_type: 'credit_alphanum12', asset_code: PHP.code, asset_issuer: issuer, balance: '100.0000000', selling_liabilities: '0.0000000' },
      ]) },
    });
    try {
      expect((await gw.accountBalance(a, MXN))?.raw).toBe(70_0000000n);
      expect(await gw.accountBalance(S.Keypair.random().publicKey(), MXN)).toBeNull();
      expect(await gw.accountBalance(b, MXN)).toBeNull();
    } finally {
      close();
    }
  });

  it('getTransaction exposes a hash memo and nothing for a text memo', async () => {
    const tx = (hash: string, memo_type: string, memo: string) => ({
      id: hash, hash, ledger: 7, successful: true, memo_type, memo, result_xdr: '', _links: {},
    });
    const { gw, close } = await horizonWith({
      '/transactions/aa': { body: tx('aa', 'hash', 'bWluZQ==') },
      '/transactions/bb': { body: tx('bb', 'text', 'hello') },
    });
    try {
      expect(await gw.getTransaction('aa')).toMatchObject({ status: 'SUCCESS', memoHash: 'bWluZQ==' });
      expect(await gw.getTransaction('bb')).not.toHaveProperty('memoHash');
    } finally {
      close();
    }
  });
});

describe('payment account (spec-varial-fix 4.3/4.4)', () => {
  const params = {
    networkPassphrase: NP, sender: expected.sender, paymentAccount: PAY, paymentSequence: '7000', recipient,
    dest: expected.dest, sendMax: expected.sendMax, path: expected.path, now: NOW,
  };

  it('both modes: the payment account is the transaction source and its sequence is used, the sender pays and signs, fee 0', () => {
    for (const mode of ['presigned', 'balance'] as const) {
      const tx = buildStrictReceive({ ...params, mode });
      expect(tx.source).toBe(PAY);
      expect(tx.operations[0].source).toBe(expected.sender);
      expect(tx.fee).toBe('0');
      expect(tx.sequence).toBe(mode === 'balance' ? '7001' : String(7000n + SEQ_WINDOW));
      expect(tx.minAccountSequence).toBe(mode === 'balance' ? undefined : '7000');
      tx.sign(sender);
      const bound = assertBoundPayment(tx.toXDR(), expected, NP, NOW, mode);
      expect(bound.sequenceAccount).toBe(PAY);
      expect(signedSourceAccount(tx.toXDR(), NP)).toBe(PAY);
      expect(signedSourceAccount(sponsor.feeBump(tx.toXDR()), NP)).toBe(PAY);
      expect(signedSequence(tx.toXDR(), NP)).toBe(BigInt(tx.sequence));
    }
  });

  /** A presigned-shaped blob with the transaction source, the operation source and the signers given. */
  const shaped = (txSource: string, opSource: string | undefined, signers: S.Keypair[]) => {
    const tx = new S.TransactionBuilder(new S.Account(txSource, '5099'), {
      fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 600 }, minAccountSequence: '5000',
    }).addOperation(S.Operation.pathPaymentStrictReceive({
      sendAsset: new S.Asset(MXN.code, issuer), sendMax: '334.2587991', destination: recipient,
      destAsset: new S.Asset(PHP.code, issuer), destAmount: '1000', path: [new S.Asset(USDC.code, USDC.issuer)],
      ...(opSource ? { source: opSource } : {}),
    })).build();
    for (const k of signers) tx.sign(k);
    return tx.toXDR();
  };

  it('refuses the Phase 1 shape, a missing or foreign operation source, the payment account key, a second signature, another payment account', () => {
    const z = S.Keypair.random();
    const exp = { ...expected, paymentAccount: z.publicKey() };
    expect(() => assertBoundPayment(shaped(z.publicKey(), expected.sender, [sender]), exp, NP, NOW)).not.toThrow();
    // The Phase 1 shape: the sender is the transaction source (the wallet's fee source).
    reject(shaped(expected.sender, expected.sender, [sender]), /source is not the sender's payment account/, exp);
    reject(shaped(expected.sender, undefined, [sender]), /source is not the sender's payment account/, exp);
    reject(shaped(z.publicKey(), undefined, [sender]), /operation source is not the sender/, exp);
    reject(shaped(z.publicKey(), S.Keypair.random().publicKey(), [sender]), /operation source is not the sender/, exp);
    // The payment account's master key has weight 0: its signature alone authorizes nothing.
    reject(shaped(z.publicKey(), expected.sender, [z]), /not signed by the sender/, exp);
    reject(shaped(z.publicKey(), expected.sender, [sender, z]), /exactly one signature/, exp);
    reject(shaped(S.Keypair.random().publicKey(), expected.sender, [sender]), /source is not the sender's payment account/, exp);
  });
});

describe('isPaymentAccount', () => {
  const sp = sponsorKey.publicKey();
  const p = sender.publicKey();
  /** The record shape Horizon returned for the judge's probe J1 (Z: XLM 0, signers [U:1, Z:0]). */
  const record = (o: Partial<AccountRecordLike> = {}): AccountRecordLike => ({
    id: PAY, sponsor: sp,
    thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
    signers: [{ key: p, weight: 1, type: 'ed25519_public_key', sponsor: sp }, { key: PAY, weight: 0, type: 'ed25519_public_key' }],
    balances: [{ asset_type: 'native' }],
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
    ...o,
  });

  it('is true for the J1 record shape', () => {
    expect(isPaymentAccount(record(), p, sp)).toBe(true);
  });

  it('is false for an extra signer, a master weight above 0, a wrong sponsor, a trustline, a threshold, a flag, the sender itself', () => {
    const r = record();
    expect(isPaymentAccount(record({ signers: [...r.signers, { key: S.Keypair.random().publicKey(), weight: 1, type: 'ed25519_public_key' }] }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ signers: [r.signers[0], { key: PAY, weight: 1, type: 'ed25519_public_key' }] }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ sponsor: S.Keypair.random().publicKey() }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ sponsor: undefined }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ balances: [{ asset_type: 'native' }, { asset_type: 'credit_alphanum12' }] }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 } }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ flags: { auth_required: true } }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ signers: [{ key: p, weight: 1, type: 'sha256_hash' }, r.signers[1]] }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ id: p, signers: [{ key: p, weight: 0, type: 'ed25519_public_key' }, r.signers[0]] }), p, sp)).toBe(false);
    expect(isPaymentAccount(record(), S.Keypair.random().publicKey(), sp)).toBe(false);
    // S1-2: an account the sponsor created, reshaped by its owner, whose sender signer the sponsor does not sponsor.
    expect(isPaymentAccount(record({ signers: [{ key: p, weight: 1, type: 'ed25519_public_key' }, r.signers[1]] }), p, sp)).toBe(false);
    expect(isPaymentAccount(record({ signers: [{ key: p, weight: 1, type: 'ed25519_public_key', sponsor: S.Keypair.random().publicKey() }, r.signers[1]] }), p, sp)).toBe(false);
  });
});

describe('payment-account setup (spec-varial-fix S1: its own transaction, sponsor + throwaway key)', () => {
  const sp = sponsorKey.publicKey();
  const p = sender.publicKey();
  const z = S.Keypair.random();
  const built = () => buildPaymentAccountSetup({ networkPassphrase: NP, sponsor: sp, sponsorSequence: '10', sender: p, paymentAccount: z.publicKey(), now: NOW });

  type SetOpts = Parameters<typeof S.Operation.setOptions>[0];
  const canonicalOptions = (): SetOpts => ({
    source: z.publicKey(), masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1, signer: { ed25519PublicKey: p, weight: 1 },
  });
  /** The payment-account sandwich with its parts replaced. */
  const sandwich = (o: { z?: string; balance?: string; options?: SetOpts[]; extra?: S.xdr.Operation[] } = {}) => {
    const id = o.z ?? z.publicKey();
    const b = new S.TransactionBuilder(new S.Account(sp, '10'), { fee: '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 300 } })
      .addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: id, source: sp }))
      .addOperation(S.Operation.createAccount({ destination: id, startingBalance: o.balance ?? '0', source: sp }));
    for (const so of o.options ?? [{ ...canonicalOptions(), source: id }]) b.addOperation(S.Operation.setOptions(so));
    for (const e of o.extra ?? []) b.addOperation(e);
    return b.addOperation(S.Operation.endSponsoringFutureReserves({ source: id })).build().toXDR();
  };

  it('builds begin, createAccount 0, setOptions (master 0, 1/1/1, the sender as signer), end; the sponsor signs it', () => {
    const tx = built();
    expect(tx.operations.map((o) => o.type)).toEqual(['beginSponsoringFutureReserves', 'createAccount', 'setOptions', 'endSponsoringFutureReserves']);
    expect(tx.operations.map((o) => o.source)).toEqual([sp, sp, z.publicKey(), z.publicKey()]);
    expect(tx.toXDR()).toBe(sandwich());
    const signed = S.TransactionBuilder.fromXDR(signAt(tx.toXDR()), NP) as S.Transaction;
    expect(signed.signatures).toHaveLength(1);
  });

  it('the sender\'s own setup keeps its Phase 1 shape and still signs (accepts 4.1 and 4.2 as two transactions)', () => {
    for (const accountExists of [false, true]) {
      const own = buildSponsoredSetup({ networkPassphrase: NP, sponsor: sp, sponsorSequence: '11', account: p, accountExists, trust: [MXN], now: NOW });
      expect(own.operations.some((o) => o.type === 'setOptions')).toBe(false);
      expect(() => signAt(own.toXDR())).not.toThrow();
    }
  });

  it('refuses every other shape', () => {
    const cases: [string, RegExp][] = [
      [sandwich({ options: [{ ...canonicalOptions(), masterWeight: 1 }] }), /master key must have weight 0/],
      [sandwich({ options: [{ ...canonicalOptions(), lowThreshold: 0 }] }), /thresholds must be 1\/1\/1/],
      [sandwich({ options: [{ ...canonicalOptions(), medThreshold: 2 }] }), /thresholds must be 1\/1\/1/],
      [sandwich({ options: [{ ...canonicalOptions(), highThreshold: 0 }] }), /thresholds must be 1\/1\/1/],
      [sandwich({ options: [{ ...canonicalOptions(), homeDomain: 'evil.example' }] }), /may not set homeDomain/],
      [sandwich({ options: [{ ...canonicalOptions(), setFlags: 1 as S.AuthFlag }] }), /may not set setFlags/],
      [sandwich({ options: [{ ...canonicalOptions(), inflationDest: sp }] }), /may not set inflationDest/],
      [sandwich({ options: [canonicalOptions(), { source: z.publicKey(), signer: { ed25519PublicKey: S.Keypair.random().publicKey(), weight: 1 } }] }), /exactly four operations/],
      [sandwich({ options: [{ ...canonicalOptions(), signer: { ed25519PublicKey: sp, weight: 1 } }] }), /signer must be the sender/],
      [sandwich({ options: [{ ...canonicalOptions(), signer: { ed25519PublicKey: p, weight: 2 } }] }), /one ed25519 signer with weight 1/],
      [sandwich({ options: [{ ...canonicalOptions(), signer: { preAuthTx: Buffer.alloc(32), weight: 1 } }] }), /one ed25519 signer with weight 1/],
      [sandwich({ balance: '1' }), /0 XLM/],
      [sandwich({ z: sp, options: [{ ...canonicalOptions(), source: sp }] }), /sponsor cannot sponsor itself|cannot sponsor itself/],
      [sandwich({ extra: [S.Operation.changeTrust({ asset: new S.Asset(MXN.code, issuer), source: z.publicKey() })] }), /exactly four operations/],
    ];
    for (const [xdr, reason] of cases) expect(() => signAt(xdr), String(reason)).toThrow(reason);
    // Z = P: the sender cannot be its own payment account (it would add itself as a signer).
    expect(() => signAt(sandwich({ z: p, options: [{ ...canonicalOptions(), source: p }] }))).toThrow(/signer must be the sender/);
    // Two payment-account sandwiches in one transaction.
    const z2 = S.Keypair.random().publicKey();
    const two = new S.TransactionBuilder(new S.Account(sp, '10'), { fee: '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 300 } });
    for (const id of [z.publicKey(), z2]) {
      two.addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: id, source: sp }))
        .addOperation(S.Operation.createAccount({ destination: id, startingBalance: '0', source: sp }))
        .addOperation(S.Operation.setOptions({ ...canonicalOptions(), source: id }))
        .addOperation(S.Operation.endSponsoringFutureReserves({ source: id }));
    }
    expect(() => signAt(two.build().toXDR())).toThrow(/exactly four operations/);
    // setOptions outside the payment-account sandwich: inside the sender's own setup.
    const own = new S.TransactionBuilder(new S.Account(sp, '10'), { fee: '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 300 } })
      .addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: p, source: sp }))
      .addOperation(S.Operation.createAccount({ destination: p, startingBalance: '0', source: sp }))
      .addOperation(S.Operation.changeTrust({ asset: new S.Asset(MXN.code, issuer), source: p }))
      .addOperation(S.Operation.setOptions({ source: p, signer: { ed25519PublicKey: S.Keypair.random().publicKey(), weight: 1 } }))
      .addOperation(S.Operation.endSponsoringFutureReserves({ source: p }))
      .build().toXDR();
    expect(() => signAt(own)).toThrow(SponsorRefusal);
  });

  it('assertPaymentAccountSetup: the browser accepts only this payment account with the sender as its only signer', () => {
    const ok = signAt(built().toXDR());
    expect(() => assertPaymentAccountSetup(ok, p, z.publicKey(), NP, sp)).not.toThrow();
    expect(() => assertPaymentAccountSetup(ok, S.Keypair.random().publicKey(), z.publicKey(), NP, sp)).toThrow(/signer must be the sender/);
    expect(() => assertPaymentAccountSetup(ok, p, S.Keypair.random().publicKey(), NP, sp)).toThrow(/another payment account/);
    // A tampered setup: an extra signer on Z, or the master key left with weight.
    const extra = sandwich({ options: [canonicalOptions(), { source: z.publicKey(), signer: { ed25519PublicKey: sp, weight: 1 } }] });
    expect(() => assertPaymentAccountSetup(extra, p, z.publicKey(), NP, sp)).toThrow();
    expect(() => assertPaymentAccountSetup(sandwich({ options: [{ ...canonicalOptions(), masterWeight: 1 }] }), p, z.publicKey(), NP, sp)).toThrow(/weight 0/);
    // The browser holds no sponsor-side check: a funded createAccount is refused here too.
    expect(() => assertPaymentAccountSetup(sandwich({ balance: '1' }), p, z.publicKey(), NP, sp)).toThrow(/0 XLM/);
    expect(() => assertPaymentAccountSetup(sponsor.feeBump(signedPayment()), p, z.publicKey(), NP, sp)).toThrow(/fee-bump/);
  });
});

describe('paymentAccountOf (Horizon ?signer=)', () => {
  it('returns the lowest-id payment account, ignoring the sender itself and look-alikes; null when none', async () => {
    const sp = sponsorKey.publicKey();
    const p = sender.publicKey();
    const [a, b] = [S.Keypair.random().publicKey(), S.Keypair.random().publicKey()].sort();
    const rec = (id: string, o: Record<string, unknown> = {}) => ({
      id, account_id: id, sequence: '1', sponsor: sp, subentry_count: 0, data: {}, _links: {},
      thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
      signers: [{ key: id, weight: 0, type: 'ed25519_public_key' }, { key: p, weight: 1, type: 'ed25519_public_key', sponsor: sp }],
      balances: [{ asset_type: 'native', balance: '0.0000000' }],
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
      ...o,
    });
    let records: unknown[] = [];
    let query = '';
    const server = createServer((req, res) => {
      query = req.url!;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ _links: { next: { href: '' } }, _embedded: { records } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const gw = createHorizonGateway({ horizonUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, networkPassphrase: NP, sponsor });
      records = [
        rec(p, { signers: [{ key: p, weight: 1, type: 'ed25519_public_key' }] }),
        rec(b), rec(a), rec(S.Keypair.random().publicKey(), { sponsor: S.Keypair.random().publicKey() }),
      ];
      expect(await gw.paymentAccountOf(p)).toBe(a);
      expect(query).toContain(`signer=${p}`);
      records = [rec(p, { signers: [{ key: p, weight: 1, type: 'ed25519_public_key' }] })];
      expect(await gw.paymentAccountOf(p)).toBeNull();
    } finally {
      server.close();
    }
  });

  it('S1-1 reads past page 1: a payment account behind 200 look-alikes (anyone can add the sender as a signer) is still found', async () => {
    const sp = sponsorKey.publicKey();
    const p = sender.publicKey();
    const z = S.Keypair.random().publicKey();
    const rec = (id: string, o: Record<string, unknown> = {}) => ({
      id, account_id: id, sequence: '1', sponsor: sp, subentry_count: 0, data: {}, _links: {}, paging_token: id,
      thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
      signers: [{ key: id, weight: 0, type: 'ed25519_public_key' }, { key: p, weight: 1, type: 'ed25519_public_key', sponsor: sp }],
      balances: [{ asset_type: 'native', balance: '0.0000000' }],
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
      ...o,
    });
    // The attacker's accounts list the sender as a signer, but their signer entry is not sponsored by Corra.
    const junk = Array.from({ length: 200 }, () => rec(S.Keypair.random().publicKey(), {
      signers: [{ key: 'X', weight: 0, type: 'ed25519_public_key' }, { key: p, weight: 1, type: 'ed25519_public_key' }],
    }));
    const pages: string[] = [];
    let base = '';
    const server = createServer((req, res) => {
      const u = new URL(req.url!, base);
      res.setHeader('content-type', 'application/json');
      if (u.pathname.startsWith('/accounts/')) {
        const id = u.pathname.split('/')[2];
        const found = [...junk, rec(z)].find((r) => r.id === id);
        res.statusCode = found ? 200 : 404;
        res.end(JSON.stringify(found ?? { status: 404 }));
        return;
      }
      pages.push(u.searchParams.get('cursor') ?? '');
      const second = u.searchParams.get('cursor') === 'p2';
      const records = second ? [rec(z)] : junk;
      res.end(JSON.stringify({ _links: { next: { href: `${base}/accounts?signer=${p}&limit=200&cursor=${second ? 'p3' : 'p2'}` } }, _embedded: { records } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const gw = createHorizonGateway({ horizonUrl: base, networkPassphrase: NP, sponsor });
      expect(await gw.paymentAccountOf(p)).toBe(z);
      expect(pages).toEqual(['', 'p2']);
      // The direct check ignores the listing: Z passes, a look-alike and a missing account do not.
      expect(await gw.isPaymentAccountOf(z, p)).toBe(true);
      expect(await gw.isPaymentAccountOf(junk[0].id, p)).toBe(false);
      expect(await gw.isPaymentAccountOf(S.Keypair.random().publicKey(), p)).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('paymentAccountOf reads only as far as the first match (J-u6-34)', () => {
  const sp = () => sponsorKey.publicKey();
  const rec = (id: string, p: string, o: Record<string, unknown> = {}) => ({
    id, account_id: id, sequence: '1', sponsor: sp(), subentry_count: 0, data: {}, _links: {}, paging_token: id,
    thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
    signers: [{ key: id, weight: 0, type: 'ed25519_public_key' }, { key: p, weight: 1, type: 'ed25519_public_key', sponsor: sp() }],
    balances: [{ asset_type: 'native', balance: '0.0000000' }],
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
    ...o,
  });
  /** A Horizon whose ?signer= listing is `page1` (200 records) then `page2`; returns the cursors read. */
  async function withListing(page1: unknown[], page2: unknown[], fn: (gw: ReturnType<typeof createHorizonGateway>) => Promise<void>) {
    const pages: string[] = [];
    let base = '';
    const server = createServer((req, res) => {
      const u = new URL(req.url!, base);
      res.setHeader('content-type', 'application/json');
      pages.push(u.searchParams.get('cursor') ?? '');
      const second = u.searchParams.get('cursor') === 'p2';
      res.end(JSON.stringify({ _links: { next: { href: `${base}/accounts?limit=200&cursor=${second ? 'p3' : 'p2'}` } }, _embedded: { records: second ? page2 : page1 } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await fn(createHorizonGateway({ horizonUrl: base, networkPassphrase: NP, sponsor }));
    } finally {
      server.close();
    }
    return pages;
  }
  const junk = (p: string, n: number) => Array.from({ length: n }, () => rec(S.Keypair.random().publicKey(), p, {
    signers: [{ key: 'X', weight: 0, type: 'ed25519_public_key' }, { key: p, weight: 1, type: 'ed25519_public_key' }],
  }));

  it('GW-U6-1 a full first page that holds a match is the only page read', async () => {
    const p = sender.publicKey();
    const [z1, z2] = [S.Keypair.random().publicKey(), S.Keypair.random().publicKey()].sort();
    const pages = await withListing([...junk(p, 198), rec(z2, p), rec(z1, p)], [rec(S.Keypair.random().publicKey(), p)], async (gw) => {
      expect(await gw.paymentAccountOf(p)).toBe(z1);
    });
    expect(pages).toEqual(['']);
  });

  it('GW-U6-2 without a match the listing is walked as before, to its last page', async () => {
    const p = sender.publicKey();
    const pages = await withListing(junk(p, 200), junk(p, 3), async (gw) => {
      expect(await gw.paymentAccountOf(p)).toBeNull();
    });
    expect(pages).toEqual(['', 'p2']);
  });
});

describe('cash-out payment (D3)', () => {
  const R = S.Keypair.random();
  const Z = S.Keypair.random();
  const DIST = S.Keypair.random().publicKey();
  const amount = fromDecimal(PHP, '1000');
  const idMemo: CashOutMemo = { type: 'id', value: '881016339300600955' };
  const hashHex = 'ab'.repeat(32);
  const hashB64 = Buffer.from(hashHex, 'hex').toString('base64');
  const exp = { recipient: R.publicKey(), destination: DIST, amount };
  const coSponsor = createSponsor(sponsorKey.secret(), NP, {
    trustIssuer: issuer, trustCodes: ['TESTMXN', 'TESTPHP'], cashOut: { destination: DIST, asset: PHP },
  });

  const build = (memo: CashOutMemo = idMemo) => buildCashOutPayment({
    networkPassphrase: NP, recipient: R.publicKey(), paymentAccount: Z.publicKey(), paymentSequence: '7000',
    destination: DIST, amount, memo, now: NOW,
  });
  const canonical = (memo: CashOutMemo = idMemo) => {
    const tx = build(memo);
    tx.sign(R);
    return tx.toXDR();
  };

  type Shape = {
    source: string; seq: string; fee: string; minTime: number; maxTime: number; memo: S.Memo | null;
    ops: S.xdr.Operation[]; extra: Record<string, unknown>; signers: S.Keypair[];
  };
  const payOp = (o: Partial<{ source: string | undefined; destination: string; asset: S.Asset; amount: string }> = {}) => S.Operation.payment({
    source: 'source' in o ? o.source : R.publicKey(), destination: o.destination ?? DIST,
    asset: o.asset ?? new S.Asset('TESTPHP', issuer), amount: o.amount ?? '1000',
  });
  /** The canonical shape with one thing changed. */
  const shape = (change: (d: Shape) => void = () => {}) => {
    const d: Shape = {
      source: Z.publicKey(), seq: '7000', fee: '0', minTime: 0, maxTime: NOW + CASH_OUT_TTL_SEC,
      memo: S.Memo.id(idMemo.value), ops: [payOp()], extra: {}, signers: [R],
    };
    change(d);
    const b = new S.TransactionBuilder(new S.Account(d.source, d.seq), {
      fee: d.fee, networkPassphrase: NP, timebounds: { minTime: d.minTime, maxTime: d.maxTime }, ...(d.memo ? { memo: d.memo } : {}), ...d.extra,
    });
    d.ops.forEach((o) => b.addOperation(o));
    const tx = b.build();
    d.signers.forEach((k) => tx.sign(k));
    return tx.toXDR();
  };
  const refuse = (xdr: string, msg: string, nowSec = NOW) => {
    expect(() => assertCashOutPayment(xdr, exp, NP, nowSec)).toThrow(new UnboundTransactionError(msg));
  };

  it('CO1 builds tx source Z at its next sequence, fee 0, a 5-minute bound, the recipient paying the distribution account with the memo', () => {
    const tx = build();
    expect(tx.source).toBe(Z.publicKey());
    expect(tx.sequence).toBe('7001');
    expect(tx.fee).toBe('0');
    expect(Number(tx.timeBounds!.minTime)).toBe(0);
    expect(Number(tx.timeBounds!.maxTime)).toBe(NOW + 300);
    expect(tx.minAccountSequence).toBeUndefined();
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as S.Operation.Payment;
    expect(op).toMatchObject({ type: 'payment', source: R.publicKey(), destination: DIST, amount: '1000.0000000' });
    expect((op.asset as S.Asset).getCode()).toBe('TESTPHP');
    expect((op.asset as S.Asset).getIssuer()).toBe(issuer);
    expect(tx.memo.type).toBe(S.MemoID);
    expect(String(tx.memo.value)).toBe(idMemo.value);
    expect(build({ type: 'text', value: 'pickup 42' }).memo.type).toBe(S.MemoText);
    const h1 = build({ type: 'hash', value: hashHex }).memo.value as Buffer;
    const h2 = build({ type: 'hash', value: hashB64 }).memo.value as Buffer;
    expect(Buffer.from(h1).equals(Buffer.from(h2))).toBe(true);
    expect(Buffer.from(h1).toString('hex')).toBe(hashHex);
  });

  it('CO1 toSdkMemo refuses an id that is not a u64 decimal, text over 28 bytes, and a hash that is not 32 bytes', () => {
    expect(() => toSdkMemo({ type: 'id', value: '-1' })).toThrow();
    expect(() => toSdkMemo({ type: 'id', value: '18446744073709551616' })).toThrow();
    expect(() => toSdkMemo({ type: 'id', value: '12a' })).toThrow();
    expect(() => toSdkMemo({ type: 'text', value: 'x'.repeat(29) })).toThrow();
    expect(() => toSdkMemo({ type: 'hash', value: 'ab'.repeat(31) })).toThrow();
    expect(() => toSdkMemo({ type: 'hash', value: Buffer.alloc(31).toString('base64') })).toThrow();
    expect(() => toSdkMemo({ type: 'return' as any, value: hashHex })).toThrow();
    expect(toSdkMemo({ type: 'id', value: '18446744073709551615' }).type).toBe(S.MemoID);
  });

  it('CO2 the canonical blob passes for every memo type and returns its hash, maxTime, sequence, source and memo', () => {
    for (const memo of [idMemo, { type: 'text', value: 'pickup 42' } as CashOutMemo, { type: 'hash', value: hashHex } as CashOutMemo]) {
      const xdr = canonical(memo);
      const b = assertCashOutPayment(xdr, exp, NP, NOW);
      const tx = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
      expect(b.hash).toBe(Buffer.from(tx.hash()).toString('hex'));
      expect(b.maxTime).toBe(NOW + 300);
      expect(b.sequence).toBe(7001n);
      expect(b.sequenceAccount).toBe(Z.publicKey());
      expect(sameMemo(b.memo, memo)).toBe(true);
    }
    expect(assertCashOutPayment(canonical({ type: 'hash', value: hashHex }), exp, NP, NOW).memo).toEqual({ type: 'hash', value: hashB64 });
  });

  it('C1 garbage; a blob signed for another network (the passphrase is only in the signed hash, so C13 refuses it)', () => {
    refuse('AAAA', 'not a transaction envelope for this network');
    const tx = buildCashOutPayment({ networkPassphrase: S.Networks.PUBLIC, recipient: R.publicKey(), paymentAccount: Z.publicKey(),
      paymentSequence: '7000', destination: DIST, amount, memo: idMemo, now: NOW });
    tx.sign(R);
    refuse(tx.toXDR(), 'not signed by the recipient');
  });
  it('C2 a fee-bump', () => {
    const bump = buildFeeBump(S.TransactionBuilder.fromXDR(canonical(), NP) as S.Transaction, Z.publicKey(), NP);
    refuse(bump.toXDR(), 'fee-bump envelopes are not accepted');
  });
  it('C3 the recipient as transaction source (the pre-Varial shape)', () => {
    refuse(shape((d) => { d.source = R.publicKey(); }), "source must be the recipient's payment account");
  });
  it('C4 two operations, a path payment', () => {
    refuse(shape((d) => { d.ops = [payOp(), payOp()]; }), 'expected exactly one payment');
    const path = S.Operation.pathPaymentStrictReceive({ source: R.publicKey(), sendAsset: new S.Asset('TESTPHP', issuer), sendMax: '1000',
      destination: DIST, destAsset: new S.Asset('TESTPHP', issuer), destAmount: '1000' });
    refuse(shape((d) => { d.ops = [path]; }), 'expected exactly one payment');
  });
  it('C5 operation source missing or another account', () => {
    refuse(shape((d) => { d.ops = [payOp({ source: undefined })]; }), 'operation source is not the recipient');
    refuse(shape((d) => { d.ops = [payOp({ source: S.Keypair.random().publicKey() })]; }), 'operation source is not the recipient');
  });
  it("C6 another G destination, and the distribution's muxed M address", () => {
    refuse(shape((d) => { d.ops = [payOp({ destination: S.Keypair.random().publicKey() })]; }), "destination is not the anchor's distribution account");
    const muxed = new S.MuxedAccount(new S.Account(DIST, '0'), '7').accountId();
    refuse(shape((d) => { d.ops = [payOp({ destination: muxed })]; }), "destination is not the anchor's distribution account");
  });
  it('C7 native, TESTMXN, TESTPHP of another issuer', () => {
    for (const asset of [S.Asset.native(), new S.Asset('TESTMXN', issuer), new S.Asset('TESTPHP', S.Keypair.random().publicKey())]) {
      refuse(shape((d) => { d.ops = [payOp({ asset })]; }), "asset is not TESTPHP from Corra's issuer");
    }
  });
  it('C8 one stroop more or less', () => {
    refuse(shape((d) => { d.ops = [payOp({ amount: '1000.0000001' })]; }), "amount must equal the payment's destination amount, 1000.0000000");
    refuse(shape((d) => { d.ops = [payOp({ amount: '999.9999999' })]; }), "amount must equal the payment's destination amount, 1000.0000000");
  });
  it('C9 no memo, a return memo', () => {
    refuse(shape((d) => { d.memo = null; }), "the anchor's memo is required");
    refuse(shape((d) => { d.memo = S.Memo.return(hashHex); }), "the anchor's memo is required");
  });
  it('C10 an inner fee', () => {
    refuse(shape((d) => { d.fee = '1'; }), 'inner fee must be 0; Corra pays through a fee-bump');
  });
  it('C11 minTime, expired, beyond the window', () => {
    refuse(shape((d) => { d.minTime = 5; }), 'minTime must be 0');
    refuse(shape((d) => { d.maxTime = NOW - 1; }), 'already expired');
    refuse(shape((d) => { d.maxTime = NOW + 361; }), 'maxTime beyond the allowed window');
    expect(() => assertCashOutPayment(shape((d) => { d.maxTime = NOW + 360; }), exp, NP, NOW)).not.toThrow();
  });
  it('C11b the recorded blob skips only the time window: past maxTime it binds; another blob, or a wrong signer, still refuses', () => {
    const xdr = canonical();
    const { hash } = assertCashOutPayment(xdr, exp, NP, NOW);
    expect(assertCashOutPayment(xdr, exp, NP, NOW + 10_000, hash).hash).toBe(hash);
    expect(() => assertCashOutPayment(xdr, exp, NP, NOW + 10_000, 'ab'.repeat(32))).toThrow(new UnboundTransactionError('already expired'));
    const zSigned = shape((d) => { d.signers = [Z]; });
    const zHash = Array.from((S.TransactionBuilder.fromXDR(zSigned, NP) as S.Transaction).hash(), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(() => assertCashOutPayment(zSigned, exp, NP, NOW + 10_000, zHash)).toThrow(new UnboundTransactionError('not signed by the recipient'));
  });
  it('C12 minSeqNum, extraSigners, ledgerBounds, minSeqAge, minSeqLedgerGap', () => {
    const extras: Record<string, unknown>[] = [
      { minAccountSequence: '7000' },
      { extraSigners: [S.SignerKey.encodeSignerKey(S.SignerKey.decodeAddress(S.Keypair.random().publicKey()))] },
      { ledgerbounds: { minLedger: 0, maxLedger: 99_999_999 } },
      { minAccountSequenceAge: 10 },
      { minAccountSequenceLedgerGap: 2 },
    ];
    for (const extra of extras) refuse(shape((d) => { d.extra = extra; }), 'unexpected preconditions');
  });
  it("C13 unsigned, signed by Z's key, two signatures", () => {
    refuse(shape((d) => { d.signers = []; }), "expected exactly one signature, the recipient's");
    refuse(shape((d) => { d.signers = [Z]; }), 'not signed by the recipient');
    refuse(shape((d) => { d.signers = [R, Z]; }), "expected exactly one signature, the recipient's");
  });

  it('CO4 cashOutFactsOf: a plain and a fee-bumped envelope give the same facts; null for two ops, a path payment, garbage', () => {
    const xdr = canonical();
    const bumped = buildFeeBump(S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction, sponsorKey.publicKey(), NP).toXDR();
    const f = cashOutFactsOf(xdr, NP);
    expect(f).toEqual({ txSource: Z.publicKey(), from: R.publicKey(), destination: DIST, asset: PHP, amountRaw: amount.raw, memo: idMemo });
    expect(cashOutFactsOf(bumped, NP)).toEqual(f);
    expect(cashOutFactsOf(shape((d) => { d.ops = [payOp({ source: undefined })]; }), NP)!.from).toBe(Z.publicKey());
    expect(cashOutFactsOf(shape((d) => { d.ops = [payOp(), payOp()]; }), NP)).toBeNull();
    const path = S.Operation.pathPaymentStrictReceive({ sendAsset: S.Asset.native(), sendMax: '1', destination: DIST, destAsset: S.Asset.native(), destAmount: '1' });
    expect(cashOutFactsOf(shape((d) => { d.ops = [path]; }), NP)).toBeNull();
    expect(cashOutFactsOf('garbage', NP)).toBeNull();
    expect(cashOutFactsOf(shape((d) => { d.memo = null; }), NP)!.memo).toBeNull();
  });

  it('CO4 sameMemo across encodings and types', () => {
    expect(sameMemo({ type: 'hash', value: hashHex }, { type: 'hash', value: hashB64 })).toBe(true);
    expect(sameMemo({ type: 'hash', value: hashHex.toUpperCase() }, { type: 'hash', value: hashB64 })).toBe(true);
    expect(sameMemo({ type: 'hash', value: hashHex }, { type: 'hash', value: 'cd'.repeat(32) })).toBe(false);
    expect(sameMemo({ type: 'id', value: '0042' }, { type: 'id', value: '42' })).toBe(true);
    expect(sameMemo({ type: 'id', value: '42' }, { type: 'text', value: '42' })).toBe(false);
    expect(sameMemo({ type: 'text', value: 'a' }, { type: 'text', value: 'A' })).toBe(false);
  });

  it('SP-CO1 the sponsor fee-bumps the canonical cash-out: outer fee source the sponsor, one signature', () => {
    const bump = S.TransactionBuilder.fromXDR(coSponsor.feeBump(canonical()), NP) as S.FeeBumpTransaction;
    expect(bump.feeSource).toBe(sponsorKey.publicKey());
    expect(bump.signatures).toHaveLength(1);
    expect(bump.innerTransaction.toXDR()).toBe(canonical());
  });

  it('SP-CO1 refuses without a cash-out scope, and every payment that is not a recipient cash-out to the distribution account', () => {
    const me = sponsorKey.publicKey();
    expect(() => sponsor.feeBump(canonical())).toThrow(new SponsorRefusal('no cash-out destination is configured'));
    const where = new SponsorRefusal('a payment is fee-bumped only to the anchor distribution account in TESTPHP');
    expect(() => coSponsor.feeBump(shape((d) => { d.ops = [payOp({ destination: S.Keypair.random().publicKey() })]; }))).toThrow(where);
    expect(() => coSponsor.feeBump(shape((d) => { d.ops = [payOp({ destination: me })]; }))).toThrow(where);
    for (const asset of [new S.Asset('TESTMXN', issuer), S.Asset.native(), new S.Asset('TESTPHP', S.Keypair.random().publicKey())]) {
      expect(() => coSponsor.feeBump(shape((d) => { d.ops = [payOp({ asset })]; }))).toThrow(where);
    }
    const opSource = new SponsorRefusal('a cash-out payment needs the recipient as operation source');
    expect(() => coSponsor.feeBump(shape((d) => { d.ops = [payOp({ source: undefined })]; }))).toThrow(opSource);
    expect(() => coSponsor.feeBump(shape((d) => { d.ops = [payOp({ source: Z.publicKey() })]; }))).toThrow(opSource);
    expect(() => coSponsor.feeBump(shape((d) => { d.memo = null; }))).toThrow(new SponsorRefusal('a cash-out payment needs the anchor memo'));
    expect(() => coSponsor.feeBump(shape((d) => { d.ops = [payOp({ source: me })]; }))).toThrow(new SponsorRefusal('sponsor cannot be an operation source'));
    expect(() => coSponsor.feeBump(shape((d) => { d.source = me; }))).toThrow(new SponsorRefusal('sponsor cannot be the inner source'));
  });
});

describe('sponsor and channel accounts (Unit 5)', () => {
  const sp = sponsorKey.publicKey();
  const p = sender.publicKey();
  const z = S.Keypair.random();
  const C = S.Keypair.random().publicKey();
  const withChannels = createSponsor(sponsorKey.secret(), NP, { trustIssuer: issuer, trustCodes: ['TESTMXN', 'TESTPHP'], channels: [C] });
  const own = (o: { source?: string; exists?: boolean; account?: string } = {}) => buildSponsoredSetup({
    networkPassphrase: NP, sponsor: sp, sponsorSequence: '10', ...(o.source ? { txSource: { account: o.source, sequence: '7000' } } : {}),
    account: o.account ?? p, accountExists: o.exists ?? false, trust: [MXN], now: NOW,
  });
  const pa = (source?: string, opts: { sponsor?: string } = {}) => buildPaymentAccountSetup({
    networkPassphrase: NP, sponsor: opts.sponsor ?? sp, sponsorSequence: '10', ...(source ? { txSource: { account: source, sequence: '7000' } } : {}),
    sender: p, paymentAccount: z.publicKey(), now: NOW,
  });

  it('SP-C1 signSetup accepts both shapes sourced by a channel in scope; refuses an unknown source', () => {
    for (const tx of [own({ source: C }), pa(C)]) {
      const signed = S.TransactionBuilder.fromXDR(withChannels.signSetup(tx.toXDR(), NOW), NP) as S.Transaction;
      expect(signed.source).toBe(C);
      expect(signed.signatures).toHaveLength(1);
    }
    expect(() => withChannels.signSetup(own({ source: S.Keypair.random().publicKey() }).toXDR(), NOW)).toThrow(/sourced by the sponsor/);
    // The default scope has no channels: the same channel-sourced setup is refused.
    expect(() => sponsor.signSetup(own({ source: C }).toXDR(), NOW)).toThrow(/sourced by the sponsor/);
  });

  it('SP-C2 refuses a channel-sourced trustline-only setup and a channel as the account set up', () => {
    expect(() => withChannels.signSetup(own({ source: C, exists: true }).toXDR(), NOW)).toThrow(/creates a new account/);
    expect(() => withChannels.signSetup(own({ exists: true }).toXDR(), NOW)).not.toThrow();
    expect(() => withChannels.signSetup(own({ account: C }).toXDR(), NOW)).toThrow(/channel account cannot be set up/);
  });

  it('SP-C3 feeBump refuses a path payment whose transaction source or operation source is a channel', () => {
    const asTxSource = buildStrictReceive({
      networkPassphrase: NP, sender: p, paymentAccount: C, paymentSequence: '1', recipient, dest: expected.dest, sendMax: expected.sendMax, path: expected.path, now: NOW,
    });
    asTxSource.sign(sender);
    expect(() => withChannels.feeBump(asTxSource.toXDR())).toThrow(/channel account/);
    const asOpSource = buildStrictReceive({
      networkPassphrase: NP, sender: C, paymentAccount: PAY, paymentSequence: '1', recipient, dest: expected.dest, sendMax: expected.sendMax, path: expected.path, now: NOW,
    }).toXDR();
    expect(() => withChannels.feeBump(asOpSource)).toThrow(/channel account/);
    expect(() => withChannels.feeBump(signedPayment())).not.toThrow();
  });

  it('SP-C4 a memo or another precondition is refused on a sponsor-sourced setup too', () => {
    const b = (o: { memo?: S.Memo; minAccountSequence?: string }) => {
      const t = new S.TransactionBuilder(new S.Account(sp, '10'), {
        fee: '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 300 }, ...o,
      });
      for (const op of [
        S.Operation.beginSponsoringFutureReserves({ sponsoredId: p, source: sp }),
        S.Operation.createAccount({ destination: p, startingBalance: '0', source: sp }),
        S.Operation.changeTrust({ asset: new S.Asset(MXN.code, issuer), source: p }),
        S.Operation.endSponsoringFutureReserves({ source: p }),
      ]) t.addOperation(op);
      return t.build().toXDR();
    };
    expect(() => signAt(b({}))).not.toThrow();
    expect(() => signAt(b({ memo: S.Memo.text('hi') }))).toThrow(/no memo/);
    expect(() => signAt(b({ minAccountSequence: '5' }))).toThrow(/no other precondition/);
  });

  it('SP-C5 the builders with txSource: that source at sequence + 1, operation sources unchanged', () => {
    for (const [withC, without] of [[own({ source: C }), own()], [pa(C), pa()]]) {
      expect([withC.source, withC.sequence]).toEqual([C, '7001']);
      expect([without.source, without.sequence]).toEqual([sp, '11']);
      expect(withC.operations.map((o) => o.source)).toEqual(without.operations.map((o) => o.source));
      expect(withC.operations[0].source).toBe(sp);
    }
  });

  it('PA-C1 assertPaymentAccountSetup accepts a channel-sourced setup with the explicit sponsor; refuses a foreign begin, the sender or Z as source', () => {
    const viaChannel = withChannels.signSetup(pa(C).toXDR(), NOW);
    expect(() => assertPaymentAccountSetup(viaChannel, p, z.publicKey(), NP, sp)).not.toThrow();
    const stranger = S.Keypair.random().publicKey();
    expect(() => assertPaymentAccountSetup(pa(C, { sponsor: stranger }).toXDR(), p, z.publicKey(), NP, sp)).toThrow(/sponsor beginning sponsorship/);
    expect(() => assertPaymentAccountSetup(viaChannel, p, z.publicKey(), NP, stranger)).toThrow(/sponsor beginning sponsorship/);
    for (const source of [p, z.publicKey()]) {
      expect(() => assertPaymentAccountSetup(pa(source).toXDR(), p, z.publicKey(), NP, sp)).toThrow(/sourced by the sponsor or a channel account/);
    }
  });
});
