import * as S from '@stellar/stellar-sdk';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertPoolSubmit, MAX_SOROBAN_RESOURCE_FEE, PoolRefusal, type PoolScope } from './pool';
import { createSponsor, SponsorRefusal } from './sponsor';
import { createPoolChain } from './soroban';
import {
  accountKey, addressEntry, AMOUNT, build, canonical, contractFn, dataKey, draftOf, FAKE_POOL, FAKE_SAC, invocation, ISSUER,
  NOW, NP, PAYMENT_ACCOUNT, RESOURCE_FEE, SCOPE, sourceEntry, transfer, trustlineKey, user,
} from '../test/pool-fixtures';

const sponsorKey = S.Keypair.random();
const SPONSOR = sponsorKey.publicKey();
const other = S.Keypair.random();
const OTHER = other.publicKey();
const sponsor = createSponsor(sponsorKey.secret(), NP, { trustIssuer: ISSUER, trustCodes: ['TESTMXN'], pool: SCOPE });

const hexHash = (xdr: string) => {
  const tx = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
  return Array.from(tx.hash(), (b) => b.toString(16).padStart(2, '0')).join('');
};

const accept = (xdr: string, scope: PoolScope = SCOPE, now = NOW, sp = SPONSOR) => assertPoolSubmit(xdr, scope, NP, now, sp);

function refused(xdr: string, message: string, scope: PoolScope = SCOPE, now = NOW) {
  let err: unknown;
  try {
    accept(xdr, scope, now);
  } catch (e) {
    err = e;
  }
  expect(err, message).toBeInstanceOf(PoolRefusal);
  expect((err as Error).message).toBe(message);
}

const positionsOf = (g: string) => S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol('Positions'), new S.Address(g).toScVal()]);
const req = (request_type: number, amount = AMOUNT, address = FAKE_SAC) => ({ request_type, address, amount });
const sym = (s: string) => S.xdr.ScVal.scvSymbol(s);

describe('assertPoolSubmit: the only Soroban shape the sponsor fee-bumps', () => {
  it('PS1 accepts the canonical supply and returns its facts', () => {
    const xdr = canonical('supply');
    expect(accept(xdr)).toEqual({
      hash: hexHash(xdr), account: user.publicKey(), paymentAccount: PAYMENT_ACCOUNT, kind: 'supply', amountRaw: AMOUNT,
      resourceFee: RESOURCE_FEE, maxTime: NOW + 300,
    });
  });

  it('PS2 accepts the canonical withdraw, which has no sub-invocation', () => {
    expect(accept(canonical('withdraw'))).toMatchObject({ kind: 'withdraw', amountRaw: AMOUNT });
  });

  it('PS3 refuses garbage and a fee-bump envelope', () => {
    refused('AAAA', 'not a transaction envelope');
    const inner = S.TransactionBuilder.fromXDR(canonical('supply'), NP) as S.Transaction;
    const bump = S.TransactionBuilder.buildFeeBumpTransaction(OTHER, '1000', inner, NP);
    bump.sign(other);
    refused(bump.toXDR(), 'already fee-bumped');
  });

  it('PS4 refuses the sponsor as source and a muxed source', () => {
    refused(canonical('supply', (d) => { d.txSource = SPONSOR; }), 'sponsor cannot be the inner source');
    refused(canonical('supply', (d) => { d.muxedId = '7'; }), 'source must be a plain G account');
  });

  it('PS5 refuses two operations and a classic operation', () => {
    const pay = S.Operation.payment({ destination: OTHER, asset: S.Asset.native(), amount: '1' });
    refused(canonical('supply', (d) => { d.extraOps = [pay]; }), 'exactly one operation');
    refused(canonical('supply', (d) => { d.replaceOp = pay; }), 'only a contract call');
    refused(canonical('supply', (d) => { d.replaceOp = S.Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) }); }), 'only a contract call');
  });

  it('PS6 the operation source is the signer: set, a plain G account, apart from the transaction source and the sponsor', () => {
    const msg = 'operation source must be the signer, apart from the transaction source and the sponsor';
    refused(canonical('supply', (d) => { d.opSource = undefined; }), msg);
    // The Phase 1 shape: the signer is also the transaction source, so it is the fee source in the wallet.
    refused(canonical('supply', (d) => { d.txSource = d.source; }), msg);
    refused(canonical('supply', undefined, sponsorKey), msg);
    // Transaction source = the payment account, operation source = the signer: accepted.
    expect(accept(canonical('supply'))).toMatchObject({ account: user.publicKey(), paymentAccount: PAYMENT_ACCOUNT });
  });

  it('PS7 refuses another contract', () => {
    refused(canonical('supply', (d) => { d.contract = S.StrKey.encodeContract(Buffer.alloc(32, 9)); }), 'only the Corra pool');
  });

  it('PS8 refuses submit_with_allowance and flash_loan', () => {
    for (const fn of ['submit_with_allowance', 'flash_loan']) refused(canonical('supply', (d) => { d.fn = fn; }), 'only submit');
  });

  it('PS9 refuses from, spender or to other than the signer', () => {
    for (const field of ['from', 'spender', 'to'] as const) {
      refused(canonical('withdraw', (d) => { d[field] = OTHER; }), 'from, spender and to must be the signer');
    }
    refused(canonical('withdraw', (d) => { d.to = FAKE_SAC; }), 'from, spender and to must be the signer');
    // Compared with the signer (the operation source), not the transaction source.
    for (const field of ['from', 'spender', 'to'] as const) {
      refused(canonical('withdraw', (d) => { d[field] = d.txSource; }), 'from, spender and to must be the signer');
    }
  });

  it('PS10 refuses zero and two requests', () => {
    refused(canonical('withdraw', (d) => { d.requests = []; }), 'exactly one request');
    refused(canonical('withdraw', (d) => { d.requests = [req(1), req(1)]; }), 'exactly one request');
  });

  it('PS11 refuses every request type but supply and withdraw (type 2 simulates fine On-Ice: this rule is the only guard)', () => {
    for (let t = 2; t <= 9; t++) refused(canonical('withdraw', (d) => { d.requests = [req(t)]; }), 'only supply or withdraw');
  });

  it('PS12 refuses another asset', () => {
    refused(canonical('withdraw', (d) => { d.requests = [req(1, AMOUNT, S.StrKey.encodeContract(Buffer.alloc(32, 7)))]; }), 'only the pool asset');
  });

  it('PS13 refuses amount 0 and above the cap; accepts the cap', () => {
    refused(canonical('supply', (d) => { d.requests = [req(0, 0n)]; }), 'amount out of range');
    refused(canonical('supply', (d) => { d.requests = [req(0, SCOPE.maxAmountRaw + 1n)]; }), 'amount out of range');
    expect(accept(canonical('supply', (d) => { d.requests = [req(0, SCOPE.maxAmountRaw)]; })).amountRaw).toBe(SCOPE.maxAmountRaw);
  });

  it('PS14 refuses address credentials, two or no entries, and a root that is not this very submit', () => {
    refused(canonical('withdraw', (d) => { d.auth = (c) => [addressEntry(d.source, (c[0] as any).rootInvocation)]; }),
      'address-credential auth entries are not allowed');
    refused(canonical('withdraw', (d) => { d.auth = (c) => [c[0], addressEntry(OTHER, (c[0] as any).rootInvocation)]; }),
      'address-credential auth entries are not allowed');
    refused(canonical('withdraw', (d) => { d.auth = (c) => [c[0], c[0]]; }), 'exactly one auth entry');
    refused(canonical('withdraw', (d) => { d.auth = () => []; }), 'exactly one auth entry');
    refused(canonical('withdraw', (d) => {
      d.auth = (_c, ic) => [sourceEntry(invocation(contractFn(FAKE_POOL, 'submit_with_allowance', (ic as any).args)))];
    }), 'auth must be the signer\'s own submit');
    refused(canonical('withdraw', (d) => {
      d.auth = (_c, ic) => [sourceEntry(invocation(contractFn(FAKE_POOL, 'submit', [...(ic as any).args.slice(0, 3), S.xdr.ScVal.scvVec([])])))];
    }), 'auth must be the signer\'s own submit');
  });

  it('PS15 refuses any sub-invocation but the exact supply transfer', () => {
    const src = user.publicKey();
    refused(canonical('supply', (d) => { d.subs = (c) => [...c, transfer(src, FAKE_POOL, AMOUNT)]; }), 'unexpected sub-invocation');
    refused(canonical('supply', (d) => { d.subs = () => [transfer(src, OTHER, AMOUNT)]; }), 'unexpected sub-invocation');
    refused(canonical('supply', (d) => { d.subs = () => [transfer(src, S.StrKey.encodeContract(Buffer.alloc(32, 9)), AMOUNT)]; }), 'unexpected sub-invocation');
    refused(canonical('supply', (d) => { d.subs = () => [transfer(src, FAKE_POOL, AMOUNT - 1n)]; }), 'unexpected sub-invocation');
    refused(canonical('supply', (d) => { d.subs = () => [transfer(src, FAKE_POOL, AMOUNT, S.StrKey.encodeContract(Buffer.alloc(32, 3)))]; }), 'unexpected sub-invocation');
    refused(canonical('supply', (d) => {
      d.subs = (c) => [invocation((c[0] as any).function, [transfer(src, OTHER, AMOUNT)])];
    }), 'unexpected sub-invocation');
    refused(canonical('supply', (d) => { d.subs = () => []; }), 'unexpected sub-invocation');
    // The transfer is from the signer, not from the transaction source.
    refused(canonical('supply', (d) => { d.subs = () => [transfer(d.txSource, FAKE_POOL, AMOUNT)]; }), 'unexpected sub-invocation');
    refused(canonical('withdraw', (d) => { d.subs = () => [transfer(src, FAKE_POOL, AMOUNT)]; }), 'unexpected sub-invocation');
    // Raw arms: a u64 amount or a string from converts to the same native value but traps on chain.
    const rawTransfer = (args: S.xdr.ScVal[]) => invocation(contractFn(FAKE_SAC, 'transfer', args));
    const [from, to] = [new S.Address(src).toScVal(), new S.Address(FAKE_POOL).toScVal()];
    refused(canonical('supply', (d) => { d.subs = () => [rawTransfer([from, to, S.nativeToScVal(AMOUNT, { type: 'u64' })])]; }), 'unexpected sub-invocation');
    refused(canonical('supply', (d) => { d.subs = () => [rawTransfer([S.xdr.ScVal.scvString(src), to, S.nativeToScVal(AMOUNT, { type: 'i128' })])]; }), 'unexpected sub-invocation');
    refused(canonical('supply', (d) => { d.subs = () => [rawTransfer([from, S.xdr.ScVal.scvString(FAKE_POOL), S.nativeToScVal(AMOUNT, { type: 'i128' })])]; }), 'unexpected sub-invocation');
  });

  it('PS16 refuses a resource fee above the cap or below zero; accepts the cap', () => {
    const cap = SCOPE.maxResourceFee;
    refused(canonical('withdraw', (d) => { d.resourceFee = cap + 1n; d.fee = cap + 1n; }), 'resource fee out of range');
    // A negative declared resource fee (Int64) with fee 0 would pass the fee rule and make buildFeeBump throw.
    const env = build(draftOf('withdraw'), (d) => { d.signers = []; }).toEnvelope() as any;
    env.value.tx.ext.value.resourceFee = S.xdr.Int64.fromString('-1');
    env.value.tx.fee = 0;
    const negative = new S.Transaction(env, NP);
    negative.sign(user);
    refused(negative.toXDR(), 'resource fee out of range');
    expect(accept(canonical('withdraw', (d) => { d.resourceFee = cap; d.fee = cap; })).resourceFee).toBe(cap);
    expect(cap).toBe(MAX_SOROBAN_RESOURCE_FEE);
  });

  it('PS17 the inner fee is the resource fee plus 0..100 stroops', () => {
    const msg = 'inner fee must be the resource fee (plus at most 100 stroops)';
    refused(canonical('withdraw', (d) => { d.fee = RESOURCE_FEE + 101n; }), msg);
    refused(canonical('withdraw', (d) => { d.fee = RESOURCE_FEE - 1n; }), msg);
    expect(accept(canonical('withdraw', (d) => { d.fee = RESOURCE_FEE; }))).toBeTruthy();
    expect(accept(canonical('withdraw', (d) => { d.fee = RESOURCE_FEE + 100n; }))).toBeTruthy();
  });

  it('PS18 refuses a footprint naming the sponsor; the issuer account key is fine', () => {
    const msg = 'footprint touches the sponsor';
    refused(canonical('withdraw', (d) => { d.readOnly = [...d.readOnly, accountKey(SPONSOR)]; }), msg);
    refused(canonical('withdraw', (d) => { d.readWrite = [...d.readWrite, trustlineKey(SPONSOR)]; }), msg);
    refused(canonical('withdraw', (d) => { d.readWrite = [...d.readWrite, dataKey(FAKE_POOL, positionsOf(SPONSOR))]; }), msg);
    const nested = S.xdr.ScVal.scvMap([new S.xdr.ScMapEntry({ key: sym('k'), val: S.xdr.ScVal.scvVec([new S.Address(SPONSOR).toScVal()]) })]);
    refused(canonical('withdraw', (d) => { d.readOnly = [...d.readOnly, dataKey(FAKE_SAC, nested)]; }), msg);
    const d = draftOf('withdraw');
    expect(d.readOnly.some((k) => (k as any).type === 'account')).toBe(true);
    expect(accept(build(d).toXDR())).toBeTruthy();
  });

  it('PS19 refuses a memo', () => {
    refused(canonical('withdraw', (d) => { d.memo = S.Memo.text('hi'); }), 'no memo');
  });

  it('PS20 needs a time bound within 6 minutes and no other preconditions', () => {
    const tb = 'needs a time bound within the next 6 minutes';
    refused(canonical('withdraw', (d) => { d.maxTime = NOW; }), tb);
    refused(canonical('withdraw', (d) => { d.maxTime = NOW + 361; }), tb);
    refused(canonical('withdraw', (d) => { d.maxTime = 0; }), tb);
    refused(canonical('withdraw', (d) => { d.minTime = 1; }), tb);
    expect(accept(canonical('withdraw', (d) => { d.maxTime = NOW + 360; })).maxTime).toBe(NOW + 360);
    const pre = 'no other preconditions';
    refused(canonical('withdraw', (d) => { d.ledgerbounds = { minLedger: 0, maxLedger: 9_999_999 }; }), pre);
    refused(canonical('withdraw', (d) => { d.minAccountSequence = '40'; }), pre);
    refused(canonical('withdraw', (d) => { d.minAccountSequenceAge = 1n; }), pre);
    refused(canonical('withdraw', (d) => { d.minAccountSequenceLedgerGap = 1; }), pre);
    refused(canonical('withdraw', (d) => { d.extraSigners = [OTHER]; }), pre);
  });

  it('PS21 must be signed exactly once, by its operation source', () => {
    const msg = 'must be signed once by its operation source';
    refused(canonical('withdraw', (d) => { d.signers = []; }), msg);
    refused(canonical('withdraw', (d) => { d.signers = [user, other]; }), msg);
    refused(canonical('withdraw', (d) => { d.signers = [other]; }), msg);
    // Signed by the transaction source's key only (the payment account's master key has weight 0 on chain).
    refused(canonical('withdraw', (d) => { d.txSource = OTHER; d.signers = [other]; }), msg);
  });

  it('PS22 refuses a malformed request map', () => {
    const pk = user.publicKey();
    const head = [pk, pk, pk].map((g) => new S.Address(g).toScVal());
    const entry = (k: string, v: S.xdr.ScVal) => new S.xdr.ScMapEntry({ key: sym(k), val: v });
    const good = [entry('address', new S.Address(FAKE_SAC).toScVal()), entry('amount', S.nativeToScVal(AMOUNT, { type: 'i128' })),
      entry('request_type', S.xdr.ScVal.scvU32(1))];
    const withArg3 = (v: S.xdr.ScVal) => canonical('withdraw', (d) => { d.args = [...head, S.xdr.ScVal.scvVec([v])]; });
    expect(accept(withArg3(S.xdr.ScVal.scvMap(good)))).toBeTruthy();
    refused(withArg3(S.xdr.ScVal.scvMap([...good, entry('to', new S.Address(OTHER).toScVal())])), 'malformed request');
    refused(withArg3(S.xdr.ScVal.scvMap([good[0], entry('amount', S.xdr.ScVal.scvU32(5)), good[2]])), 'malformed request');
    refused(withArg3(S.xdr.ScVal.scvMap([entry('address', new S.Address(OTHER).toScVal()), good[1], good[2]])), 'malformed request');
    refused(withArg3(S.xdr.ScVal.scvU32(1)), 'malformed request');
    // Raw arms, not scValToNative: a u64 amount, an i32 type, a string address and a repeated key are all refused (J-R3).
    refused(withArg3(S.xdr.ScVal.scvMap([good[0], entry('amount', S.nativeToScVal(AMOUNT, { type: 'u64' })), good[2]])), 'malformed request');
    refused(withArg3(S.xdr.ScVal.scvMap([good[0], good[1], entry('request_type', S.xdr.ScVal.scvI32(1))])), 'malformed request');
    refused(withArg3(S.xdr.ScVal.scvMap([entry('address', S.xdr.ScVal.scvString(FAKE_SAC)), good[1], good[2]])), 'malformed request');
    refused(withArg3(S.xdr.ScVal.scvMap([good[0], good[1], good[1]])), 'malformed request');
    refused(withArg3(S.xdr.ScVal.scvMap([good[0], good[1], good[1], good[2]])), 'malformed request');
  });

  it('PS23 refuses a submit without Soroban data', () => {
    refused(canonical('withdraw', (d) => { d.sorobanData = false; d.fee = 100n; }), 'not a Soroban transaction');
  });

  it('PS24 is a typed error the API maps to 422', () => {
    try {
      accept(canonical('withdraw', (d) => { d.requests = [req(4)]; }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PoolRefusal);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe('PoolRefusal');
    }
  });

  const LIVE = new URL('./fixtures/pool-submit.live.json', import.meta.url);
  it.runIf(existsSync(LIVE))('PS-live accepts the supply and withdraw pool-check recorded on testnet', () => {
    const live = JSON.parse(readFileSync(LIVE, 'utf8'));
    const scope = { poolId: live.poolId, asset: live.asset, maxAmountRaw: SCOPE.maxAmountRaw, maxResourceFee: MAX_SOROBAN_RESOURCE_FEE };
    const s = assertPoolSubmit(live.supply.xdr, scope, NP, live.supply.nowSec, live.sponsor);
    expect(s).toMatchObject({ account: live.source, paymentAccount: live.paymentAccount, kind: 'supply' });
    const w = assertPoolSubmit(live.withdraw.xdr, scope, NP, live.withdraw.nowSec, live.sponsor);
    expect(w).toMatchObject({ account: live.source, paymentAccount: live.paymentAccount, kind: 'withdraw' });
  });
  if (!existsSync(LIVE)) console.log('PS-live skipped: run pool-check to record src/fixtures/pool-submit.live.json');
});

describe('sponsor fee-bumps a validated pool submit', () => {
  it('SP1 outer fee = resource fee + 2 x 1000, signed only by the sponsor, inner signature unchanged', () => {
    const xdr = canonical('supply');
    const bump = S.TransactionBuilder.fromXDR(sponsor.feeBump(xdr, undefined, NOW), NP) as S.FeeBumpTransaction;
    expect(bump.feeSource).toBe(SPONSOR);
    expect(BigInt(bump.fee)).toBe(RESOURCE_FEE + 2_000n);
    expect(bump.signatures).toHaveLength(1);
    expect(sponsorKey.verify(Buffer.from(bump.hash()), Buffer.from((bump.signatures[0] as any).signature.value ?? (bump.signatures[0] as any).signature))).toBe(true);
    expect(bump.innerTransaction.toXDR()).toBe(xdr);
  });

  it('SP2 refuses a Soroban inner when no pool is configured', () => {
    const plain = createSponsor(sponsorKey.secret(), NP, { trustIssuer: ISSUER, trustCodes: ['TESTMXN'] });
    expect(() => plain.feeBump(canonical('supply'), undefined, NOW)).toThrow(new SponsorRefusal('no pool is configured'));
  });

  it('SP3 refuses another classic operation, a payment with no cash-out scope, and a two-op path payment', () => {
    const tx = (ops: S.xdr.Operation[]) => {
      const b = new S.TransactionBuilder(new S.Account(user.publicKey(), '1'), { fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 60 } });
      ops.forEach((o) => b.addOperation(o));
      const t = b.build();
      t.sign(user);
      return t.toXDR();
    };
    const data = S.Operation.manageData({ name: 'x', value: 'y' });
    expect(() => sponsor.feeBump(tx([data]), undefined, NOW)).toThrow(new SponsorRefusal('operation not allowed in a fee-bump: manageData'));
    const pay = S.Operation.payment({ destination: OTHER, asset: S.Asset.native(), amount: '1' });
    expect(() => sponsor.feeBump(tx([pay]), undefined, NOW)).toThrow(new SponsorRefusal('no cash-out destination is configured'));
    const path = S.Operation.pathPaymentStrictReceive({ sendAsset: S.Asset.native(), sendMax: '1', destination: OTHER, destAsset: S.Asset.native(), destAmount: '1' });
    expect(() => sponsor.feeBump(tx([path, path]), undefined, NOW)).toThrow(new SponsorRefusal('a fee-bumped transaction carries exactly one operation'));
  });

  it('SP4 a request type 4 refusal propagates as a PoolRefusal', () => {
    expect(() => sponsor.feeBump(canonical('withdraw', (d) => { d.requests = [req(4)]; }), undefined, NOW))
      .toThrow(new PoolRefusal('only supply or withdraw'));
  });

  it('SP5 refuses a path payment whose operation source is the sponsor', () => {
    const b = new S.TransactionBuilder(new S.Account(user.publicKey(), '1'), { fee: '100', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: NOW + 60 } });
    b.addOperation(S.Operation.pathPaymentStrictReceive({
      sendAsset: S.Asset.native(), sendMax: '1', destination: OTHER, destAsset: S.Asset.native(), destAmount: '1', source: SPONSOR,
    }));
    const t = b.build();
    t.sign(user);
    expect(() => sponsor.feeBump(t.toXDR(), undefined, NOW)).toThrow(new SponsorRefusal('sponsor cannot be an operation source'));
  });
});

type Rpc = { method: string; params: any };

/** A Stellar RPC over node:http answering from `answer`; a null answer never responds. */
async function fakeRpc(answer: (r: Rpc, n: number) => object | null) {
  const calls: Rpc[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      calls.push({ method: r.method, params: r.params });
      const result = answer({ method: r.method, params: r.params }, calls.filter((c) => c.method === r.method).length);
      if (result === null) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

/** TransactionResult XDR: feeCharged, a result code with no results, ext v0. */
function resultXdr(fee: bigint, code: number) {
  const b = Buffer.alloc(code === 0 ? 20 : 16);
  b.writeBigInt64BE(fee, 0);
  b.writeInt32BE(code, 8);
  return b.toString('base64');
}

const ledgerInfo = { latestLedger: 10, latestLedgerCloseTime: 1, oldestLedger: 1, oldestLedgerCloseTime: 1 };
const sendResult = (status: string, extra = {}) => ({ status, hash: 'ab'.repeat(32), latestLedger: 10, latestLedgerCloseTime: 1, ...extra });

describe('PoolChain over Stellar RPC', () => {
  const chainOn = (url: string) => createPoolChain({ rpcUrl: url, networkPassphrase: NP, sponsor, pollMs: 10, waitMs: 300 });
  const bumped = () => chainOn('http://127.0.0.1:1').bump(canonical('supply'), NOW);

  it('PC1 PENDING then SUCCESS with ledger and fee charged', async () => {
    const rpc = await fakeRpc((r, n) => r.method === 'sendTransaction' ? sendResult('PENDING')
      : n < 3 ? { status: 'NOT_FOUND', ...ledgerInfo } : { status: 'SUCCESS', ...ledgerInfo, ledger: 77, resultXdr: resultXdr(593_131n, 0) });
    try {
      const b = bumped();
      expect(b.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await chainOn(rpc.url).send(b.xdr)).toEqual({ status: 'SUCCESS', ledger: 77, feeCharged: 593_131n });
    } finally {
      await rpc.close();
    }
  });

  it('PC2 ERROR txBadSeq is FAILED tx_bad_seq with no ledger', async () => {
    const rpc = await fakeRpc(() => sendResult('ERROR', { errorResultXdr: resultXdr(0n, -5) }));
    try {
      expect(await chainOn(rpc.url).send(bumped().xdr)).toEqual({ status: 'FAILED', ledger: null, code: 'tx_bad_seq' });
    } finally {
      await rpc.close();
    }
  });

  it('PC3 TRY_AGAIN_LATER three times is FAILED try_again_later after 3 sends', async () => {
    const rpc = await fakeRpc(() => sendResult('TRY_AGAIN_LATER'));
    try {
      // The 1 s + 2 s back-off runs inside waitMs.
      const chain = createPoolChain({ rpcUrl: rpc.url, networkPassphrase: NP, sponsor, pollMs: 10, waitMs: 5_000 });
      expect(await chain.send(bumped().xdr)).toEqual({ status: 'FAILED', ledger: null, code: 'try_again_later' });
      expect(rpc.calls.filter((c) => c.method === 'sendTransaction')).toHaveLength(3);
    } finally {
      await rpc.close();
    }
  }, 10_000);

  it('PC4 still NOT_FOUND after waitMs is PENDING; a later status() reads it', async () => {
    const rpc = await fakeRpc((r) => r.method === 'sendTransaction' ? sendResult('DUPLICATE') : { status: 'NOT_FOUND', ...ledgerInfo });
    try {
      const chain = chainOn(rpc.url);
      expect(await chain.send(bumped().xdr)).toEqual({ status: 'PENDING' });
      expect(await chain.status('ab'.repeat(32))).toEqual({ status: 'NOT_FOUND', latestLedgerCloseTime: 1, oldestLedgerCloseTime: 1 });
    } finally {
      await rpc.close();
    }
  });

  it('PC6 a real fee-bump-wrapped invokeHostFunctionTrapped result is FAILED op_invoke_host_function_trapped', async () => {
    const x = S.xdr;
    const op = x.OperationResult.opInner(x.OperationResultTr.invokeHostFunction(x.InvokeHostFunctionResult.invokeHostFunctionTrapped()));
    const inner = new x.InnerTransactionResult({
      feeCharged: x.Int64.fromString('100'), result: x.InnerTransactionResultResult.txFailed([op]), ext: x.InnerTransactionResultExt.v0(),
    });
    const trapped = new x.TransactionResult({
      feeCharged: x.Int64.fromString('200'),
      result: x.TransactionResultResult.txFeeBumpInnerFailed(new x.InnerTransactionResultPair({ transactionHash: Buffer.alloc(32), result: inner })),
      ext: x.TransactionResultExt.v0(),
    }).toXDR('base64');
    const rpc = await fakeRpc((r) => r.method === 'sendTransaction' ? sendResult('PENDING')
      : { status: 'FAILED', ...ledgerInfo, ledger: 12, resultXdr: trapped });
    try {
      expect(await chainOn(rpc.url).send(bumped().xdr)).toEqual({ status: 'FAILED', ledger: 12, code: 'op_invoke_host_function_trapped' });
    } finally {
      await rpc.close();
    }
  });

  it('PC7 an RPC that never answers: send is PENDING at about waitMs', async () => {
    for (const hang of ['sendTransaction', 'getTransaction']) {
      const rpc = await fakeRpc((r) => r.method === hang ? null : r.method === 'sendTransaction' ? sendResult('PENDING') : { status: 'NOT_FOUND', ...ledgerInfo });
      try {
        const t0 = Date.now();
        expect(await chainOn(rpc.url).send(bumped().xdr), hang).toEqual({ status: 'PENDING' });
        expect(Date.now() - t0, hang).toBeLessThan(2_000);
      } finally {
        await rpc.close();
      }
    }
  });

  it('PC5 bump refuses a bad blob before any request', async () => {
    const rpc = await fakeRpc(() => sendResult('PENDING'));
    try {
      expect(() => chainOn(rpc.url).bump(canonical('withdraw', (d) => { d.requests = [req(2)]; }), NOW)).toThrow(PoolRefusal);
      expect(rpc.calls).toHaveLength(0);
    } finally {
      await rpc.close();
    }
  });
});
