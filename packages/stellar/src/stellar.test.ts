import * as S from '@stellar/stellar-sdk';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { fromDecimal, toDecimal } from '@corra/shared';
import { buildSponsoredSetup, buildStrictReceive, PAYMENT_TTL_SEC, SEQ_WINDOW } from './build';
import { assertBoundPayment, UnboundTransactionError, type ExpectedPayment } from './validate';
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
const recipient = S.Keypair.random().publicKey();
const sponsorKey = S.Keypair.random();
const sponsor = createSponsor(sponsorKey.secret(), NP, { trustIssuer: issuer, trustCodes: ['TESTMXN', 'TESTPHP'] });
const signAt = (xdr: string) => sponsor.signSetup(xdr, NOW);

const expected: ExpectedPayment = {
  sender: sender.publicKey(),
  recipient,
  dest: fromDecimal(PHP, '1000'),
  sendMax: fromDecimal(MXN, '334.2587991'),
  path: [USDC],
};

function signedPayment(overrides: Partial<Parameters<typeof buildStrictReceive>[0]> = {}, signer = sender) {
  const tx = buildStrictReceive({
    networkPassphrase: NP,
    sender: expected.sender,
    senderSequence: '5000',
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
    networkPassphrase: NP, sender: expected.sender, senderSequence: '5000', recipient,
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
      networkPassphrase: NP, sender: expected.sender, senderSequence: '5000', recipient,
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
    const plain = new S.TransactionBuilder(new S.Account(expected.sender, '5099'), {
      fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 600 },
    }).addOperation(S.Operation.pathPaymentStrictReceive({
      sendAsset: new S.Asset(MXN.code, issuer), sendMax: '334.2587991', destination: recipient,
      destAsset: new S.Asset(PHP.code, issuer), destAmount: '1000', path: [new S.Asset(USDC.code, USDC.issuer)],
    })).build();
    plain.sign(sender);
    reject(plain.toXDR(), /no minSeqNum/);

    const two = new S.TransactionBuilder(new S.Account(expected.sender, '5099'), {
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
      networkPassphrase: NP, sender: sponsorKey.publicKey(), senderSequence: '1', recipient,
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
});

describe('assertBoundPayment pins every precondition (audit regressions)', () => {
  const variant = (o: Record<string, unknown>, extraSigner?: S.Keypair, seqOverride?: string) => {
    const tx = new S.TransactionBuilder(new S.Account(expected.sender, seqOverride ?? '5099'), {
      fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 600 }, minAccountSequence: '5000', ...o,
    }).addOperation(S.Operation.pathPaymentStrictReceive({
      sendAsset: new S.Asset(MXN.code, issuer), sendMax: '334.2587991', destination: recipient,
      destAsset: new S.Asset(PHP.code, issuer), destAmount: '1000', path: [new S.Asset(USDC.code, USDC.issuer)],
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

