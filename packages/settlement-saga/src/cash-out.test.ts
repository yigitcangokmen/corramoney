import * as S from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { fromDecimal, toDecimal, type Corridor, type Money, type Payment, type Sep24Callback } from '@corra/shared';
import { buildCashOutPayment, SponsorRefusal, type CashOutMemo, type PathResult, type StellarGateway, type SubmitOutcome } from '@corra/stellar';
import { createCashOuts } from './cash-out';
import { InMemorySagaStore } from './store';
import { SagaError } from './errors';

const NP = S.Networks.TESTNET;
const ISSUER = S.Keypair.random().publicKey();
const DIST = S.Keypair.random().publicKey();
const PHP = { code: 'TESTPHP', issuer: ISSUER };
const MXN = { code: 'TESTMXN', issuer: ISSUER };
const BRL = { code: 'TESTBRL', issuer: ISSUER };
const CORRIDOR: Corridor = { from: { country: 'MX', currency: 'MXN' }, to: { country: 'PH', currency: 'PHP' } };
const T0 = 1_800_000_000_000;
const ANCHOR_ID = 'corra-anchor';
const MEMO: CashOutMemo = { type: 'id', value: '881016339300600955' };

const R = S.Keypair.random();
const Z = S.Keypair.random().publicKey();

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The chain as the cash-out sees it. `envelopes` holds what landed, keyed by the inner hash. */
class FakeGateway implements StellarGateway {
  outcomes: (SubmitOutcome | Error)[] = [];
  landed = new Map<string, 'SUCCESS' | 'FAILED'>();
  codes = new Map<string, string>();
  envelopes = new Map<string, string>();
  /** Horizon has not ingested the latest ledgers. */
  lagging = false;
  balances = new Map<string, Money>([[R.publicKey(), fromDecimal(PHP, '1000')]]);
  sequences = new Map<string, bigint>([[Z, 7000n]]);
  paymentAccounts = new Map<string, string>([[Z, R.publicKey()]]);
  submits: string[] = [];
  onSubmit?: (innerHash: string) => Promise<void>;

  async findStrictReceivePath(): Promise<PathResult | null> { return null; }
  async findDeposit() { return null; }
  async accountTrusts() { return true; }
  async paymentAccountOf(sender: string) { return [...this.paymentAccounts].find(([, s]) => s === sender)?.[0] ?? null; }
  async isPaymentAccountOf(account: string, sender: string) { return this.paymentAccounts.get(account) === sender; }
  async accountBalance(account: string) { return this.balances.get(account) ?? null; }
  async accountSequence(account: string) { return this.sequences.get(account) ?? null; }
  async getTransaction(hash: string) {
    const s = this.lagging ? undefined : this.landed.get(hash);
    if (!s) return { status: 'NOT_FOUND' as const };
    return { status: s, ledger: 9, hash: `env-${hash}`, codes: this.codes.get(hash), envelopeXdr: this.envelopes.get(hash) };
  }
  async submitPayment(xdr: string): Promise<SubmitOutcome> {
    const inner = hex((S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction).hash());
    this.submits.push(inner);
    await this.onSubmit?.(inner);
    const out = this.outcomes.shift() ?? { kind: 'success', hash: `env-${inner}`, ledger: 9 };
    if (out instanceof Error) throw out;
    if (out.kind === 'success') { this.landed.set(inner, 'SUCCESS'); this.envelopes.set(inner, xdr); }
    // Only an operation-level failure is in a ledger; an extras.hash alone (tx_insufficient_fee, ...) is not.
    if ((out.kind === 'failed' || out.kind === 'cap_exceeded') && out.hash && (out.codes as any)?.operations?.length) {
      this.landed.set(inner, 'FAILED');
      this.codes.set(inner, String((out.codes as any)?.operations?.[0] ?? 'tx_failed'));
      this.envelopes.set(inner, xdr);
    }
    return out;
  }
}

let t: number;
let gw: FakeGateway;
let store: InMemorySagaStore;
let co: ReturnType<typeof createCashOuts>;
let logs: ({ evt: string } & Record<string, unknown>)[];
let n: number;

beforeEach(() => {
  t = T0;
  n = 0;
  logs = [];
  gw = new FakeGateway();
  store = new InMemorySagaStore(() => t);
  co = createCashOuts({
    store, gateway: gw, networkPassphrase: NP, anchorId: ANCHOR_ID, anchorDistribution: DIST, asset: PHP, now: () => t, log: (l) => logs.push(l),
  });
});

/** A payment in `state` with the legs CREDITED writes (or `legs`), straight into the store. */
async function payment(over: { state?: Payment['state']; dest?: Money; cashOut?: Partial<Payment['legs'][number]> | null } = {}) {
  const id = `pmt_${++n}`;
  const dest = over.dest ?? fromDecimal(PHP, '1000');
  const state = over.state ?? 'CREDITED';
  const legs: Payment['legs'] = [{ kind: 'onchain', status: 'CONFIRMED', amount: dest, txHash: `onchain-${n}` }];
  if (over.cashOut !== null && state === 'CREDITED') {
    legs.push({ kind: 'cash_out', status: 'PENDING', amount: dest, anchorId: ANCHOR_ID, ...over.cashOut });
  }
  const p: Payment = {
    id, publicId: `CORRA-AAAAA${n}`, kind: 'balance', senderAccount: S.Keypair.random().publicKey(), recipientAccount: R.publicKey(),
    corridor: CORRIDOR,
    quote: { id: `qt_${n}`, mode: 'strict_receive', corridor: CORRIDOR, source: fromDecimal(MXN, '300'), dest, path: [],
      maxSend: fromDecimal(MXN, '305'), slippageBps: 150, expiresAt: T0 },
    state, legs, idemKey: `idem-${n}`, signedXdr: null, innerTxHash: `inner-${n}`, maxTime: T0 / 1000, supersedesId: null,
    createdAt: t, updatedAt: t,
  };
  await store.createPayment(p, [{ type: state, from: null, to: state, data: { txHash: `onchain-${n}`, ledger: 1 } }]);
  return p;
}

function blob(over: { amount?: Money; memo?: CashOutMemo; seq?: string; signer?: S.Keypair; destination?: string } = {}) {
  const tx = buildCashOutPayment({
    networkPassphrase: NP, recipient: R.publicKey(), paymentAccount: Z, paymentSequence: over.seq ?? '7000',
    destination: over.destination ?? DIST, amount: over.amount ?? fromDecimal(PHP, '1000'), memo: over.memo ?? MEMO, now: Math.floor(t / 1000),
  });
  tx.sign(over.signer ?? R);
  return { xdr: tx.toXDR(), hash: hex(tx.hash()) };
}

const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { return e instanceof SagaError ? e.code : (e as Error).name; }
  return 'NO_ERROR';
};
const leg = async (id: string) => (await store.getPayment(id))!.legs.find((l) => l.kind === 'cash_out');
const types = async (id: string) => (await store.events(id)).map((e) => e.type);
const callback = (ref: string, status: Sep24Callback['status'], over: Partial<Sep24Callback> = {}): Sep24Callback => ({
  ref, kind: 'withdrawal', status, anchorStatus: status === 'CONFIRMED' ? 'completed' : status === 'FAILED' ? 'error' : 'pending_anchor',
  ...(status === 'CONFIRMED' ? { withdrawMemo: MEMO, externalId: 'sim-cash-pickup-1', moreInfoUrl: 'https://anchor.test/more' } : {}),
  at: t, raw: {}, ...over,
});

describe('C2 submit golden path', () => {
  it('records ref and inner hash before the network call, then SUBMITTED and ONCHAIN, from = to = CREDITED, gapless; state stays CREDITED', async () => {
    const p = await payment();
    const b = blob();
    let seenAtSubmit: unknown;
    gw.onSubmit = async () => { seenAtSubmit = await leg(p.id); };
    const r = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr });
    expect(seenAtSubmit).toMatchObject({ status: 'PENDING', externalRef: 'w-1', txHash: b.hash });
    expect(r).toMatchObject({ txHash: `env-${b.hash}`, ledger: 9, replay: false });
    expect(r.payment.state).toBe('CREDITED');
    expect(await leg(p.id)).toMatchObject({ status: 'PENDING', externalRef: 'w-1', txHash: b.hash });
    const ev = await store.events(p.id);
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(ev.slice(1).map((e) => [e.type, e.from, e.to])).toEqual([
      ['CASH_OUT_SUBMITTED', 'CREDITED', 'CREDITED'], ['CASH_OUT_ONCHAIN', 'CREDITED', 'CREDITED'],
    ]);
    // No memo: it is public in the events before the payment lands (S2-3); the confirmation uses the anchor's signed one.
    expect(ev[1].data).toEqual({ ref: 'w-1', txHash: b.hash, maxTime: Math.floor(t / 1000) + 300 });
    expect(ev[2].data).toEqual({ ref: 'w-1', txHash: `env-${b.hash}`, ledger: 9 });
    expect(r.events).toHaveLength(3);
    expect(logs.map((l) => l.evt)).toEqual(['cashout.submitted', 'cashout.onchain']);
  });
});

describe('C3 refusals before any write', () => {
  async function refused(p: Payment, expected: string, input: { xdr?: string; admit?: () => boolean } = {}) {
    const before = { leg: await leg(p.id), events: await store.events(p.id) };
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: input.xdr ?? blob().xdr, admit: input.admit }))).toBe(expected);
    expect(await leg(p.id)).toEqual(before.leg);
    expect(await store.events(p.id)).toEqual(before.events);
    expect(gw.submits).toHaveLength(0);
  }

  it('CASH_OUT_NOT_READY for a payment that has not reached the recipient (ONCHAIN)', async () => {
    await refused(await payment({ state: 'ONCHAIN' }), 'CASH_OUT_NOT_READY');
  });
  it('CASH_OUT_NOT_AVAILABLE for a payment in TESTBRL', async () => {
    await refused(await payment({ dest: fromDecimal(BRL, '1000') }), 'CASH_OUT_NOT_AVAILABLE');
  });
  it('ALREADY_CASHED_OUT for a CONFIRMED leg and a Phase 1 mock-payout leg, and for no leg', async () => {
    await refused(await payment({ cashOut: { status: 'CONFIRMED', externalRef: 'w-0', txHash: 'h0' } }), 'ALREADY_CASHED_OUT');
    await refused(await payment({ cashOut: { status: 'CONFIRMED', externalRef: 'mock-payout:CORRA-AAAAAA', anchorId: undefined } }), 'ALREADY_CASHED_OUT');
    await refused(await payment({ cashOut: null }), 'ALREADY_CASHED_OUT');
  });
  it('UNBOUND_TRANSACTION from the validator (amount one stroop more)', async () => {
    await refused(await payment(), 'UNBOUND_TRANSACTION', { xdr: blob({ amount: fromDecimal(PHP, '1000.0000001') }).xdr });
  });
  it("UNBOUND_TRANSACTION when the source is not the recipient's payment account", async () => {
    gw.paymentAccounts.clear();
    await refused(await payment(), 'UNBOUND_TRANSACTION');
  });
  it('INSUFFICIENT_BALANCE when the recipient no longer holds the amount', async () => {
    gw.balances.set(R.publicKey(), fromDecimal(PHP, '999.9999999'));
    await refused(await payment(), 'INSUFFICIENT_BALANCE');
    gw.balances.delete(R.publicKey());
    await refused(await payment(), 'INSUFFICIENT_BALANCE');
  });
  it("UNBOUND_TRANSACTION when the sequence is not the payment account's next", async () => {
    await refused(await payment(), 'UNBOUND_TRANSACTION', { xdr: blob({ seq: '7004' }).xdr });
  });
  it('RATE_LIMITED from admit', async () => {
    await refused(await payment(), 'RATE_LIMITED', { admit: () => false });
  });
});

describe('C4 replay', () => {
  it('the same blob and ref is a replay: no new event, admit not called', async () => {
    const p = await payment();
    const b = blob();
    await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr });
    let admitted = 0;
    const r = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr, admit: () => { admitted++; return true; } });
    expect(r).toMatchObject({ replay: true, txHash: `env-${b.hash}`, ledger: 9 });
    expect(admitted).toBe(0);
    expect(await types(p.id)).toEqual(['CREDITED', 'CASH_OUT_SUBMITTED', 'CASH_OUT_ONCHAIN']);
    expect(gw.submits).toHaveLength(1);
  });

  it('the same blob with another ref is CASH_OUT_REF_MISMATCH', async () => {
    const p = await payment();
    const b = blob();
    await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-2', signedXdr: b.xdr }))).toBe('CASH_OUT_REF_MISMATCH');
  });

  it('a different blob while the first may still land is CASH_OUT_IN_PROGRESS; once it landed, CASH_OUT_ALREADY_PAID', async () => {
    const p = await payment();
    const first = blob();
    gw.outcomes.push(new Error('socket hang up'));
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: first.xdr }))).toBe('SEND_FAILED');
    const second = blob({ memo: { type: 'id', value: '7' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-2', signedXdr: second.xdr }))).toBe('CASH_OUT_IN_PROGRESS');
    gw.landed.set(first.hash, 'SUCCESS');
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-2', signedXdr: second.xdr }))).toBe('CASH_OUT_ALREADY_PAID');
    expect(await leg(p.id)).toMatchObject({ externalRef: 'w-1', txHash: first.hash });
  });

  it('a replay of a blob the network never answered for sends the same blob again', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('SEND_FAILED');
    const r = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr, admit: () => false });
    expect(r).toMatchObject({ replay: true, txHash: `env-${b.hash}` });
    expect(gw.submits).toEqual([b.hash, b.hash]);
    expect(await types(p.id)).toEqual(['CREDITED', 'CASH_OUT_SUBMITTED', 'CASH_OUT_ONCHAIN']);
  });
});

describe('C4b the recorded blob after its maxTime is still a replay (C2-4)', () => {
  it('no answer, then the same blob after maxTime: the chain decides (SUCCESS -> 200 replay; NOT_FOUND + tx_too_late -> kept, 502); another blob is still 422', async () => {
    const p = await payment();
    const b = blob();
    const other = blob({ memo: { type: 'id', value: '3' } }); // signed at the same time, never recorded
    gw.outcomes.push(new Error('socket hang up'));
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('SEND_FAILED');
    t += 301_000; // past maxTime, inside the reconciler's grace
    gw.outcomes.push({ kind: 'expired', codes: { transaction: 'tx_too_late' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('SEND_FAILED');
    expect(await leg(p.id)).toMatchObject({ txHash: b.hash, externalRef: 'w-1' });
    expect(await types(p.id)).not.toContain('CASH_OUT_FAILED');
    gw.landed.set(b.hash, 'SUCCESS');
    gw.envelopes.set(b.hash, b.xdr);
    const r = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr });
    expect(r).toMatchObject({ replay: true, txHash: `env-${b.hash}` });
    // The time window still binds every blob that is not the recorded one.
    const q = await payment();
    const err = await co.submit({ paymentId: q.id, ref: 'w-q', signedXdr: other.xdr }).catch((e) => e);
    expect(err).toMatchObject({ code: 'UNBOUND_TRANSACTION' });
    expect(err.message).toMatch(/already expired/);
  });

  it('the recorded hash skips only the clock: the same blob with another ref is still CASH_OUT_REF_MISMATCH', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }));
    t += 301_000;
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-2', signedXdr: b.xdr }))).toBe('CASH_OUT_REF_MISMATCH');
  });
});

describe('C5 one ref and one chain payment per leg', () => {
  it("a ref already on another payment's cash_in or cash_out leg is CASH_OUT_REF_TAKEN", async () => {
    const other = await payment({ state: 'CREDITED' });
    await store.linkCashIn(other.id, ANCHOR_ID, 'w-taken');
    const p = await payment();
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-taken', signedXdr: blob().xdr }))).toBe('CASH_OUT_REF_TAKEN');
    const q = await payment();
    gw.lagging = true; // so p2 does not see q's blob landed
    await co.submit({ paymentId: q.id, ref: 'w-q', signedXdr: blob().xdr });
    gw.lagging = false;
    const p2 = await payment();
    expect(await code(() => co.submit({ paymentId: p2.id, ref: 'w-q', signedXdr: blob({ memo: { type: 'id', value: '9' } }).xdr }))).toBe('CASH_OUT_REF_TAKEN');
    expect(await leg(p2.id)).not.toHaveProperty('externalRef');
  });

  it('the same signed blob for a second payment of the same recipient and amount is DUPLICATE_TRANSACTION', async () => {
    const a = await payment();
    const b = await payment();
    const x = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: a.id, ref: 'w-a', signedXdr: x.xdr }));
    expect(await code(() => co.submit({ paymentId: b.id, ref: 'w-b', signedXdr: x.xdr }))).toBe('DUPLICATE_TRANSACTION');
    expect(await leg(b.id)).not.toHaveProperty('txHash');
    expect(await types(b.id)).toEqual(['CREDITED']);
  });
});

describe('C6 outcomes', () => {
  const failedEvent = async (id: string) => (await store.events(id)).filter((e) => e.type === 'CASH_OUT_FAILED').at(-1)!.data;

  it('expired, and a first-send rejection with a result code not on chain (with or without extras.hash): cleared, reason rejected, 422 CASH_OUT_FAILED; the ref stays', async () => {
    for (const out of [
      { kind: 'expired', codes: { transaction: 'tx_too_late' } },
      { kind: 'failed', codes: { transaction: 'tx_insufficient_fee' } },
      { kind: 'failed', hash: 'env-x', codes: { transaction: 'tx_insufficient_fee' } },
    ] as SubmitOutcome[]) {
      const p = await payment();
      gw.outcomes.push(out);
      const err = await co.submit({ paymentId: p.id, ref: `w-${p.id}`, signedXdr: blob().xdr }).catch((e) => e);
      expect(err).toMatchObject({ code: 'CASH_OUT_FAILED', status: 422 });
      expect(await leg(p.id)).toMatchObject({ externalRef: `w-${p.id}` });
      expect(await leg(p.id)).not.toHaveProperty('txHash');
      expect(await failedEvent(p.id)).toMatchObject({ reason: 'rejected' });
    }
  });

  it('a landed failed transaction: cleared, reason failed, with its code', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push({ kind: 'failed', hash: 'env-x', codes: { operations: ['op_underfunded'] } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('CASH_OUT_FAILED');
    expect(await failedEvent(p.id)).toEqual({ ref: 'w-1', txHash: b.hash, reason: 'failed', codes: 'op_underfunded' });
    expect(await leg(p.id)).not.toHaveProperty('txHash');
  });

  it('no answer: the record stays, 502 SEND_FAILED; reconcile then sees SUCCESS and appends ONCHAIN once', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    const err = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SEND_FAILED', status: 502, retriable: true });
    expect(await leg(p.id)).toMatchObject({ txHash: b.hash, externalRef: 'w-1' });
    gw.landed.set(b.hash, 'SUCCESS');
    gw.envelopes.set(b.hash, b.xdr);
    t += 31_000;
    expect(await co.reconcile()).toBe(1);
    t += 31_000;
    expect(await co.reconcile()).toBe(0);
    expect(await types(p.id)).toEqual(['CREDITED', 'CASH_OUT_SUBMITTED', 'CASH_OUT_ONCHAIN']);
  });

  it('a sponsor refusal: cleared, reason rejected, rethrown as the refusal', async () => {
    const p = await payment();
    gw.outcomes.push(new SponsorRefusal('a cash-out payment needs the anchor memo'));
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob().xdr }))).toBe('SponsorRefusal');
    expect(await failedEvent(p.id)).toMatchObject({ reason: 'rejected', codes: 'a cash-out payment needs the anchor memo' });
    expect(await leg(p.id)).not.toHaveProperty('txHash');
  });

  it('after three landed failures the leg refuses with CASH_OUT_ATTEMPTS; rejections do not count', async () => {
    const p = await payment();
    gw.outcomes.push({ kind: 'failed', hash: 'env-r', codes: { transaction: 'tx_insufficient_fee' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob({ memo: { type: 'id', value: '100' } }).xdr }))).toBe('CASH_OUT_FAILED');
    for (let i = 0; i < 3; i++) {
      gw.outcomes.push({ kind: 'failed', hash: `env-${i}`, codes: { operations: ['op_no_trust'] } });
      expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob({ memo: { type: 'id', value: String(i) } }).xdr }))).toBe('CASH_OUT_FAILED');
    }
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob({ memo: { type: 'id', value: '50' } }).xdr }))).toBe('CASH_OUT_ATTEMPTS');
    expect(gw.submits).toHaveLength(4);
  });
});

describe('C6b an error body alone never clears a blob that may have landed', () => {
  const landNow = (b: { hash: string; xdr: string }) => { gw.landed.set(b.hash, 'SUCCESS'); gw.envelopes.set(b.hash, b.xdr); };

  it('SEND_FAILED that lands, then a replay meeting a lagging Horizon and tx_bad_seq: tx_hash kept; reconcile and the completed callback confirm', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('SEND_FAILED');
    landNow(b);
    gw.lagging = true;
    gw.outcomes.push({ kind: 'bad_seq', codes: { transaction: 'tx_bad_seq' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('SEND_FAILED');
    expect(await leg(p.id)).toMatchObject({ txHash: b.hash, externalRef: 'w-1' });
    expect(await types(p.id)).not.toContain('CASH_OUT_FAILED');
    // A second withdrawal is refused while the first may have landed.
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-2', signedXdr: blob({ memo: { type: 'id', value: '8' } }).xdr }))).toBe('CASH_OUT_IN_PROGRESS');
    gw.lagging = false;
    t += 31_000;
    expect(await co.reconcile()).toBe(1);
    await co.onCallback(callback('w-1', 'CONFIRMED'));
    expect((await leg(p.id))!.status).toBe('CONFIRMED');
    expect((await types(p.id)).at(-1)).toBe('CASHED_OUT');
  });

  it('bad_seq on the first send while the chain shows the blob landed: recorded ONCHAIN, 200', async () => {
    const p = await payment();
    const b = blob();
    gw.onSubmit = async () => landNow(b);
    gw.outcomes.push({ kind: 'bad_seq', codes: { transaction: 'tx_bad_seq' } });
    const r = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr });
    expect(r).toMatchObject({ txHash: `env-${b.hash}`, replay: false });
    expect(await types(p.id)).toEqual(['CREDITED', 'CASH_OUT_SUBMITTED', 'CASH_OUT_ONCHAIN']);
  });

  it('C6 (C2-2) bad_seq on a first send while the chain shows nothing: tx kept, 502 SEND_FAILED, no CASH_OUT_FAILED', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push({ kind: 'bad_seq', codes: { transaction: 'tx_bad_seq' } });
    const err = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SEND_FAILED', status: 502 });
    expect(await leg(p.id)).toMatchObject({ txHash: b.hash, externalRef: 'w-1' });
    expect(await types(p.id)).not.toContain('CASH_OUT_FAILED');
  });

  it('C6 (S2-1) a replay answered tx_too_late while Horizon lags: tx kept, 502; the chain later shows SUCCESS and reconcile appends ONCHAIN', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('SEND_FAILED');
    landNow(b);
    gw.lagging = true;
    gw.outcomes.push({ kind: 'expired', codes: { transaction: 'tx_too_late' } });
    const err = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SEND_FAILED', status: 502 });
    expect(await leg(p.id)).toMatchObject({ txHash: b.hash, externalRef: 'w-1' });
    expect(await types(p.id)).not.toContain('CASH_OUT_FAILED');
    gw.lagging = false;
    t += 31_000;
    expect(await co.reconcile()).toBe(1);
    expect((await types(p.id)).at(-1)).toBe('CASH_OUT_ONCHAIN');
  });

  it('a replay answered tx_too_late for a blob FAILED on chain: cleared with reason failed', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }));
    gw.lagging = true; // the replay's own lookup misses it, the one after the send sees it
    gw.onSubmit = async () => { gw.lagging = false; gw.landed.set(b.hash, 'FAILED'); gw.codes.set(b.hash, 'op_underfunded'); };
    gw.outcomes.push({ kind: 'expired', codes: { transaction: 'tx_too_late' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('CASH_OUT_FAILED');
    expect((await store.events(p.id)).at(-1)!.data).toMatchObject({ reason: 'failed', codes: 'op_underfunded' });
  });

  it('failed without a hash or codes (a 504) keeps the record; the blob lands later and the completed callback confirms', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push({ kind: 'failed', codes: undefined });
    const err = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }).catch((e) => e);
    expect(err).toMatchObject({ code: 'SEND_FAILED', status: 502, retriable: true });
    expect(await leg(p.id)).toMatchObject({ txHash: b.hash });
    landNow(b);
    t += 31_000;
    expect(await co.reconcile()).toBe(1);
    await co.onCallback(callback('w-1', 'CONFIRMED'));
    expect((await leg(p.id))!.status).toBe('CONFIRMED');
  });

  it('a replay with a coded rejection while the chain shows nothing keeps the record (never cleared on a replay without a chain answer)', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }));
    gw.outcomes.push({ kind: 'failed', codes: { transaction: 'tx_insufficient_fee' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('SEND_FAILED');
    expect(await leg(p.id)).toMatchObject({ txHash: b.hash });
  });

  it('failed with a hash but FAILED on chain: cleared with reason failed and the chain code', async () => {
    const p = await payment();
    const b = blob();
    gw.onSubmit = async () => { gw.landed.set(b.hash, 'FAILED'); gw.codes.set(b.hash, 'op_line_full'); };
    gw.outcomes.push({ kind: 'failed', codes: undefined });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('CASH_OUT_FAILED');
    expect((await store.events(p.id)).at(-1)!.data).toMatchObject({ reason: 'failed', codes: 'op_line_full' });
  });

  it('three rejections carrying extras.hash that never reached the chain do not lock the leg', async () => {
    const p = await payment();
    for (let i = 0; i < 3; i++) {
      gw.outcomes.push({ kind: 'failed', hash: `env-${i}`, codes: { transaction: 'tx_insufficient_fee' } });
      expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob({ memo: { type: 'id', value: String(i) } }).xdr }))).toBe('CASH_OUT_FAILED');
    }
    const reasons = (await store.events(p.id)).filter((e) => e.type === 'CASH_OUT_FAILED').map((e) => e.data?.reason);
    expect(reasons).toEqual(['rejected', 'rejected', 'rejected']);
    const r = await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob({ memo: { type: 'id', value: '9' } }).xdr });
    expect(r.replay).toBe(false);
  });
});

describe('C7-C10 the anchor-signed completed callback and the chain', () => {
  async function submitted(memo = MEMO, ref = 'w-1') {
    const p = await payment();
    const b = blob({ memo });
    await co.submit({ paymentId: p.id, ref, signedXdr: b.xdr });
    return { p, b };
  }

  it('C7 completed with a matching chain payment: CONFIRMED and CASHED_OUT {payout, moreInfoUrl}; a duplicate callback adds nothing', async () => {
    const { p, b } = await submitted();
    const after = await co.onCallback(callback('w-1', 'CONFIRMED'));
    expect(after!.state).toBe('CREDITED');
    expect(await leg(p.id)).toMatchObject({ status: 'CONFIRMED', externalRef: 'w-1', txHash: b.hash });
    const ev = await store.events(p.id);
    expect(ev.map((e) => e.type)).toEqual(['CREDITED', 'CASH_OUT_SUBMITTED', 'CASH_OUT_ONCHAIN', 'CASH_OUT_ANCHOR_COMPLETED', 'CASHED_OUT']);
    expect(ev.at(-1)!.data).toEqual({ ref: 'w-1', txHash: `env-${b.hash}`, ledger: 9, payout: 'sim-cash-pickup-1', moreInfoUrl: 'https://anchor.test/more' });
    expect(ev.every((e, i) => e.seq === i + 1)).toBe(true);
    await co.onCallback(callback('w-1', 'CONFIRMED'));
    expect(await store.events(p.id)).toHaveLength(5);
    expect(logs.map((l) => l.evt)).toContain('cashout.confirmed');
  });

  it('C8 completed while Horizon shows nothing: only ANCHOR_COMPLETED; the next reconcile confirms (order independence)', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }));
    await co.onCallback(callback('w-1', 'CONFIRMED'));
    expect(await types(p.id)).toEqual(['CREDITED', 'CASH_OUT_SUBMITTED', 'CASH_OUT_ANCHOR_COMPLETED']);
    expect((await leg(p.id))!.status).toBe('PENDING');
    gw.landed.set(b.hash, 'SUCCESS');
    gw.envelopes.set(b.hash, b.xdr);
    t += 31_000;
    expect(await co.reconcile()).toBe(1);
    expect((await leg(p.id))!.status).toBe('CONFIRMED');
    expect((await types(p.id)).at(-1)).toBe('CASHED_OUT');
  });

  describe('C9 mismatch: CASH_OUT_MISMATCH once, the leg stays PENDING', () => {
    /** The chain shows a payment differing from Corra's blob in one way, under the leg's recorded hash. */
    async function mismatch(tamper: { amount?: Money; destination?: string; asset?: boolean; from?: boolean; memo?: CashOutMemo } , ev: Partial<Sep24Callback> = {}) {
      const { p, b } = await submitted();
      const other = S.Keypair.random();
      const tx = new S.TransactionBuilder(new S.Account(Z, '7000'), {
        fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: Math.floor(t / 1000) + 300 },
        memo: tamper.memo ? S.Memo.id(tamper.memo.value) : S.Memo.id(MEMO.value),
      }).addOperation(S.Operation.payment({
        source: tamper.from ? other.publicKey() : R.publicKey(), destination: tamper.destination ?? DIST,
        asset: tamper.asset ? new S.Asset('TESTMXN', ISSUER) : new S.Asset('TESTPHP', ISSUER), amount: tamper.amount ? toDecimal(tamper.amount) : '1000',
      })).build();
      if (Object.keys(tamper).length) gw.envelopes.set(b.hash, tx.toXDR());
      await co.onCallback(callback('w-1', 'CONFIRMED', ev));
      await co.onCallback(callback('w-1', 'CONFIRMED', ev));
      t += 31_000;
      await co.reconcile();
      return p;
    }
    const expectMismatch = async (p: Payment) => {
      expect((await leg(p.id))!.status).toBe('PENDING');
      expect((await types(p.id)).filter((x) => x === 'CASH_OUT_MISMATCH')).toHaveLength(1);
      expect(await types(p.id)).not.toContain('CASHED_OUT');
    };
    it('amount', async () => expectMismatch(await mismatch({ amount: fromDecimal(PHP, '999') })));
    it('destination', async () => expectMismatch(await mismatch({ destination: S.Keypair.random().publicKey() })));
    it('asset', async () => expectMismatch(await mismatch({ asset: true })));
    it('from', async () => expectMismatch(await mismatch({ from: true })));
    it("memo != the callback's withdraw_memo", async () => expectMismatch(await mismatch({}, { withdrawMemo: { type: 'id', value: '1' } })));
    it('stellarTxId naming another transaction', async () => expectMismatch(await mismatch({}, { stellarTxId: 'ff'.repeat(32) })));
    it("stellarTxId equal to the leg's envelope hash confirms", async () => {
      const { p, b } = await submitted();
      await co.onCallback(callback('w-1', 'CONFIRMED', { stellarTxId: `env-${b.hash}` }));
      expect((await leg(p.id))!.status).toBe('CONFIRMED');
    });
  });

  it('C10 completed for a leg without tx_hash, completed without withdraw_memo, and an unknown ref confirm nothing', async () => {
    const p = await payment();
    gw.outcomes.push({ kind: 'expired', codes: { transaction: 'tx_too_late' } });
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob().xdr }));
    await co.onCallback(callback('w-1', 'CONFIRMED'));
    expect((await leg(p.id))!.status).toBe('PENDING');
    expect(await types(p.id)).not.toContain('CASHED_OUT');

    const { p: q } = await submitted({ type: 'id', value: '2' }, 'w-q');
    const qEvents = (await store.events(q.id)).length;
    await co.onCallback(callback('w-q', 'CONFIRMED', { withdrawMemo: undefined }));
    expect((await leg(q.id))!.status).toBe('PENDING');
    expect(await store.events(q.id)).toHaveLength(qEvents);

    expect(await co.onCallback(callback('nobody', 'CONFIRMED'))).toBeNull();
    expect(logs.some((l) => l.evt === 'cashout.unknown_ref')).toBe(true);
  });

  it('C10b (S2-2) a new blob for a ref the anchor already completed is CASH_OUT_ALREADY_PAID, before any write or submit', async () => {
    const p = await payment();
    const first = blob();
    gw.outcomes.push({ kind: 'expired', codes: { transaction: 'tx_too_late' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: first.xdr }))).toBe('CASH_OUT_FAILED');
    await co.onCallback(callback('w-1', 'CONFIRMED'));
    expect(await types(p.id)).toContain('CASH_OUT_ANCHOR_COMPLETED');
    const before = { leg: await leg(p.id), events: await store.events(p.id) };
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob({ memo: { type: 'id', value: '45' } }).xdr }))).toBe('CASH_OUT_ALREADY_PAID');
    expect(await leg(p.id)).toEqual(before.leg);
    expect(await store.events(p.id)).toEqual(before.events);
    expect(gw.submits).toEqual([first.hash]);
    expect(logs.some((l) => l.evt === 'cashout.mismatch' && l.ref === 'w-1')).toBe(true);
  });

  it("C10c (C2-3) an earlier ref's completed never judges the current ref's blob: no mismatch, no confirmation until its own completed", async () => {
    const p = await payment();
    const first = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-A', signedXdr: first.xdr }));
    await co.onCallback(callback('w-A', 'CONFIRMED')); // Horizon shows nothing: only ANCHOR_COMPLETED for A
    t += (300 + 120) * 1000 + 1000;
    expect(await co.reconcile()).toBe(1); // A's blob can never land: cleared
    expect(await leg(p.id)).not.toHaveProperty('txHash');
    const memoB: CashOutMemo = { type: 'id', value: '777' };
    const second = blob({ memo: memoB });
    await co.submit({ paymentId: p.id, ref: 'w-B', signedXdr: second.xdr });
    t += 31_000;
    await co.reconcile();
    expect(await types(p.id)).not.toContain('CASH_OUT_MISMATCH');
    expect((await leg(p.id))!.status).toBe('PENDING');
    await co.onCallback(callback('w-B', 'CONFIRMED', { withdrawMemo: memoB }));
    expect(await leg(p.id)).toMatchObject({ status: 'CONFIRMED', externalRef: 'w-B', txHash: second.hash });
    expect(await types(p.id)).not.toContain('CASH_OUT_MISMATCH');
  });
});

describe('C11 the anchor stops a withdrawal', () => {
  it('error/expired/refunded: CASH_OUT_ANCHOR_FAILED once per status with paid; after the reconciler clears the dead blob a new ref works', async () => {
    const p = await payment();
    const first = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: first.xdr }));
    await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'expired' }));
    await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'expired' }));
    const failed = (await store.events(p.id)).filter((e) => e.type === 'CASH_OUT_ANCHOR_FAILED');
    expect(failed.map((e) => e.data)).toEqual([{ ref: 'w-1', anchorStatus: 'expired', paid: false }]);
    expect(await leg(p.id)).toMatchObject({ txHash: first.hash, externalRef: 'w-1' });

    t += (300 + 120) * 1000 + 1000; // past maxTime + grace: the blob can never land
    expect(await co.reconcile()).toBe(1);
    expect(await leg(p.id)).not.toHaveProperty('txHash');
    gw.sequences.set(Z, 7000n);
    const second = blob({ memo: { type: 'id', value: '77' } });
    const r = await co.submit({ paymentId: p.id, ref: 'w-2', signedXdr: second.xdr });
    expect(r.replay).toBe(false);
    expect(await leg(p.id)).toMatchObject({ externalRef: 'w-2', txHash: second.hash });
    expect(await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'refunded' }))).toBeNull(); // the old ref no longer names the leg
  });

  it('a new blob for a ref the anchor already stopped is CASH_OUT_ANCHOR_STOPPED, before any write or submit', async () => {
    const p = await payment();
    const first = blob();
    gw.outcomes.push({ kind: 'expired', codes: { transaction: 'tx_too_late' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: first.xdr }))).toBe('CASH_OUT_FAILED');
    await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'expired' }));
    const before = await store.events(p.id);
    const again = blob({ memo: { type: 'id', value: '44' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: again.xdr }))).toBe('CASH_OUT_ANCHOR_STOPPED');
    expect(await store.events(p.id)).toEqual(before);
    expect(gw.submits).toEqual([first.hash]);
    // A new withdrawal (new ref) is still accepted.
    expect((await co.submit({ paymentId: p.id, ref: 'w-2', signedXdr: again.xdr })).replay).toBe(false);
  });

  it('(C6-1) a replay of the kept blob after the anchor stopped, NOT_FOUND on chain: 409 CASH_OUT_ANCHOR_STOPPED, never resent; the reconciler clears it', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('SEND_FAILED');
    await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'expired' }));
    gw.submits = [];
    const before = await store.events(p.id);
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }))).toBe('CASH_OUT_ANCHOR_STOPPED');
    expect(gw.submits).toHaveLength(0);
    expect(await store.events(p.id)).toEqual(before);
    expect(await leg(p.id)).toMatchObject({ externalRef: 'w-1', txHash: b.hash });
    t += (300 + 120) * 1000 + 1000;
    expect(await co.reconcile()).toBe(1);
    expect(await leg(p.id)).not.toHaveProperty('txHash');
  });

  it('(C6-1) a replay after the stop still answers from the chain: SUCCESS is a 200 replay, FAILED is cleared', async () => {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }));
    await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'error' }));
    gw.landed.set(b.hash, 'SUCCESS');
    gw.submits = [];
    expect((await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr })).replay).toBe(true);
    expect(gw.submits).toHaveLength(0);
  });

  it('(S6-2) a stop callback recorded while a new blob is being checked: 409 CASH_OUT_ANCHOR_STOPPED, no SUBMITTED, no submit', async () => {
    const p = await payment();
    const first = blob();
    gw.outcomes.push({ kind: 'expired', codes: { transaction: 'tx_too_late' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: first.xdr }))).toBe('CASH_OUT_FAILED');
    gw.submits = [];
    const read = gw.accountSequence.bind(gw);
    gw.accountSequence = async (account: string) => {
      await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'expired' }));
      return read(account);
    };
    const again = blob({ memo: { type: 'id', value: '45' } });
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: again.xdr }))).toBe('CASH_OUT_ANCHOR_STOPPED');
    expect(gw.submits).toHaveLength(0);
    expect((await types(p.id)).filter((x) => x === 'CASH_OUT_SUBMITTED')).toHaveLength(1);
    expect(await types(p.id)).toContain('CASH_OUT_ANCHOR_FAILED');
    expect(await leg(p.id)).not.toHaveProperty('txHash');
  });

  it('(C2-1) a stop whose chain lookup throws is still recorded, paid: false', async () => {
    const p = await payment();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob().xdr }));
    gw.getTransaction = async () => { throw new Error('horizon 503'); };
    await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'error' }));
    const failed = (await store.events(p.id)).filter((e) => e.type === 'CASH_OUT_ANCHOR_FAILED').map((e) => e.data);
    expect(failed).toEqual([{ ref: 'w-1', anchorStatus: 'error', paid: false }]);
    // The I-u4-11 protection holds: no new blob for this ref.
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob({ memo: { type: 'id', value: '6' } }).xdr }))).not.toBe('NO_ERROR');
  });

  it('paid is true when the leg transaction landed; the leg stays frozen', async () => {
    const p = await payment();
    await co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: blob().xdr });
    await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'error' }));
    await co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'refunded' }));
    const failed = (await store.events(p.id)).filter((e) => e.type === 'CASH_OUT_ANCHOR_FAILED').map((e) => e.data);
    expect(failed).toEqual([{ ref: 'w-1', anchorStatus: 'error', paid: true }, { ref: 'w-1', anchorStatus: 'refunded', paid: true }]);
    expect(await code(() => co.submit({ paymentId: p.id, ref: 'w-2', signedXdr: blob({ memo: { type: 'id', value: '5' } }).xdr }))).toBe('CASH_OUT_ALREADY_PAID');
  });
});

describe('C12 reconcile', () => {
  async function recorded() {
    const p = await payment();
    const b = blob({ memo: { type: 'id', value: String(n) } });
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: `w-${p.id}`, signedXdr: b.xdr }));
    return { p, b };
  }

  it('FAILED on chain: cleared with reason failed', async () => {
    const { p, b } = await recorded();
    gw.landed.set(b.hash, 'FAILED');
    gw.codes.set(b.hash, 'op_underfunded');
    t += 31_000;
    expect(await co.reconcile()).toBe(1);
    expect(await leg(p.id)).not.toHaveProperty('txHash');
    expect((await store.events(p.id)).at(-1)).toMatchObject({ type: 'CASH_OUT_FAILED', data: { reason: 'failed', codes: 'op_underfunded' } });
  });

  it('NOT_FOUND before maxTime + 120 s is touched; after, cleared with reason expired', async () => {
    const { p } = await recorded();
    t += 31_000;
    expect(await co.reconcile()).toBe(0);
    expect(await leg(p.id)).toHaveProperty('txHash');
    t = T0 + (300 + 60) * 1000; // past maxTime, inside the 120 s grace: a lagging Horizon may still show it
    expect(await co.reconcile()).toBe(0);
    expect(await leg(p.id)).toHaveProperty('txHash');
    t = T0 + (300 + 120) * 1000;
    expect(await co.reconcile()).toBe(1);
    expect((await store.events(p.id)).at(-1)).toMatchObject({ type: 'CASH_OUT_FAILED', data: { reason: 'expired' } });
  });

  it('SUCCESS without an anchor callback: one ONCHAIN across two passes', async () => {
    const { p, b } = await recorded();
    gw.landed.set(b.hash, 'SUCCESS');
    t += 31_000;
    expect(await co.reconcile()).toBe(1);
    t += 31_000;
    expect(await co.reconcile()).toBe(0);
    expect((await types(p.id)).filter((x) => x === 'CASH_OUT_ONCHAIN')).toHaveLength(1);
  });

  it('at most `limit` per pass; legs idle under 30 s are skipped; one throwing leg does not stop the pass', async () => {
    const a = await recorded();
    const b = await recorded();
    const c = await recorded();
    for (const x of [a, b, c]) gw.landed.set(x.b.hash, 'FAILED');
    expect(await co.reconcile()).toBe(0); // all just written
    t += 31_000;
    expect(await co.reconcile(30_000, 2)).toBe(2);
    const d = await recorded();
    gw.landed.set(d.b.hash, 'FAILED');
    const orig = gw.getTransaction.bind(gw);
    gw.getTransaction = async (h: string) => { if (h === c.b.hash) throw new Error('horizon down'); return orig(h); };
    t += 31_000;
    expect(await co.reconcile()).toBe(1);
    expect(await leg(d.p.id)).not.toHaveProperty('txHash');
    expect(logs.some((l) => l.evt === 'cashout.check_failed')).toBe(true);
  });
});

describe('C13 in-memory store CAS', () => {
  const ev = { type: 'X', from: 'CREDITED' as const, to: 'CREDITED' as const };

  it('a stale expectTxHash, a CONFIRMED leg and a non-CREDITED payment write nothing; an explicit null clears', async () => {
    const p = await payment();
    expect(await store.recordCashOut(p.id, null, { externalRef: 'r', txHash: 'h1' }, ev)).not.toBeNull();
    expect(await store.recordCashOut(p.id, null, { txHash: 'h2' }, ev)).toBeNull();
    expect(await store.recordCashOut(p.id, 'h0', { txHash: 'h2' }, ev)).toBeNull();
    expect(await leg(p.id)).toMatchObject({ txHash: 'h1', externalRef: 'r' });
    const cleared = await store.recordCashOut(p.id, 'h1', { txHash: null }, ev);
    expect(cleared!.legs.find((l) => l.kind === 'cash_out')).not.toHaveProperty('txHash');
    expect(cleared!.legs.find((l) => l.kind === 'cash_out')).toMatchObject({ externalRef: 'r' });
    await store.recordCashOut(p.id, null, { txHash: 'h3', status: 'CONFIRMED' }, ev);
    expect(await store.recordCashOut(p.id, 'h3', {}, ev)).toBeNull();
    const onchain = await payment({ state: 'ONCHAIN' });
    expect(await store.recordCashOut(onchain.id, null, { txHash: 'h4' }, ev)).toBeNull();
    expect((await store.getPayment(p.id))!.updatedAt).toBe(p.updatedAt);
  });

  it('OC10 (in memory) a Phase 1 mock-payout leg is never listed as an open cash-out', async () => {
    await payment({ cashOut: { status: 'CONFIRMED', externalRef: 'mock-payout:CORRA-AAAAAA' } });
    expect(await store.listOpenCashOuts(0, t + 1, 25)).toEqual([]);
  });
});

describe('C14 (C4-1) once-per-key events stay once under concurrent writers', () => {
  const count = async (id: string, type: string) => (await types(id)).filter((x) => x === type).length;
  const second = () => createCashOuts({
    store, gateway: gw, networkPassphrase: NP, anchorId: ANCHOR_ID, anchorDistribution: DIST, asset: PHP, now: () => t, log: (l) => logs.push(l),
  });
  /** A recorded blob the network never answered for. */
  async function unanswered() {
    const p = await payment();
    const b = blob();
    gw.outcomes.push(new Error('socket hang up'));
    await code(() => co.submit({ paymentId: p.id, ref: 'w-1', signedXdr: b.xdr }));
    return { p, b };
  }

  it('two concurrent completed callbacks (the 503 and the anchor resend): one CASH_OUT_ANCHOR_COMPLETED', async () => {
    const { p } = await unanswered();
    await Promise.all([co.onCallback(callback('w-1', 'CONFIRMED')), co.onCallback(callback('w-1', 'CONFIRMED'))]);
    expect(await count(p.id, 'CASH_OUT_ANCHOR_COMPLETED')).toBe(1);
  });

  it('two concurrent completed callbacks over a mismatching chain payment: one ANCHOR_COMPLETED, one MISMATCH', async () => {
    const { p, b } = await unanswered();
    gw.landed.set(b.hash, 'SUCCESS');
    gw.envelopes.set(b.hash, blob({ destination: S.Keypair.random().publicKey() }).xdr);
    await Promise.all([co.onCallback(callback('w-1', 'CONFIRMED')), co.onCallback(callback('w-1', 'CONFIRMED'))]);
    expect(await count(p.id, 'CASH_OUT_ANCHOR_COMPLETED')).toBe(1);
    expect(await count(p.id, 'CASH_OUT_MISMATCH')).toBe(1);
    expect((await leg(p.id))!.status).toBe('PENDING');
  });

  it('two concurrent stop callbacks with the same status: one CASH_OUT_ANCHOR_FAILED', async () => {
    const { p } = await unanswered();
    await Promise.all([
      co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'expired' })),
      co.onCallback(callback('w-1', 'FAILED', { anchorStatus: 'expired' })),
    ]);
    expect(await count(p.id, 'CASH_OUT_ANCHOR_FAILED')).toBe(1);
  });

  it('two reconcile instances over a landed blob: one CASH_OUT_ONCHAIN', async () => {
    const { p, b } = await unanswered();
    gw.landed.set(b.hash, 'SUCCESS');
    gw.envelopes.set(b.hash, b.xdr);
    t += 31_000;
    await Promise.all([co.reconcile(), second().reconcile()]);
    expect(await count(p.id, 'CASH_OUT_ONCHAIN')).toBe(1);
  });

  it('two reconcile instances over a completed withdrawal whose chain payment mismatches: one CASH_OUT_MISMATCH', async () => {
    const { p, b } = await unanswered();
    await co.onCallback(callback('w-1', 'CONFIRMED'));
    gw.landed.set(b.hash, 'SUCCESS');
    gw.envelopes.set(b.hash, blob({ amount: fromDecimal(PHP, '999') }).xdr);
    t += 31_000;
    await Promise.all([co.reconcile(), second().reconcile()]);
    expect(await count(p.id, 'CASH_OUT_MISMATCH')).toBe(1);
  });
});

describe('C15 (C4-1) in-memory store unless guard', () => {
  it('writes nothing when an event of that type already contains every field of match', async () => {
    const p = await payment();
    const ev = (data: Record<string, unknown>) => ({ type: 'Y', from: 'CREDITED' as const, to: 'CREDITED' as const, data });
    const unless = (match: Record<string, unknown>) => ({ type: 'Y', match });
    expect(await store.recordCashOut(p.id, null, {}, ev({ ref: 'a', s: null, n: 1 }), unless({ ref: 'a', s: null }))).not.toBeNull();
    expect(await store.recordCashOut(p.id, null, {}, ev({ ref: 'a', s: null }), unless({ ref: 'a', s: null }))).toBeNull();
    expect(await store.recordCashOut(p.id, null, {}, ev({ ref: 'a', s: 'x' }), unless({ ref: 'a', s: 'x' }))).not.toBeNull();
    expect(await store.recordCashOut(p.id, null, {}, ev({ ref: 'a' }), { type: 'Z', match: { ref: 'a' } })).not.toBeNull();
    expect(await types(p.id)).toEqual(['CREDITED', 'Y', 'Y', 'Y']);
  });
});
