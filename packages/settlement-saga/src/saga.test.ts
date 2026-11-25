import * as S from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { cashInMemo, fromDecimal, toDecimal, type AssetId, type Corridor, type Money } from '@corra/shared';
import {
  buildStrictReceive,
  type Deposit,
  type PathResult,
  type StellarGateway,
  type SubmitOutcome,
} from '@corra/stellar';
import { createSaga } from './saga';
import { InMemorySagaStore } from './store';
import { isAllowedTransition, isTerminal } from './transitions';
import { SagaError } from './errors';

const NP = S.Networks.TESTNET;
const ISSUER = S.Keypair.random().publicKey();
const ANCHOR = S.Keypair.random().publicKey();
const MXN = { code: 'TESTMXN', issuer: ISSUER };
const PHP = { code: 'TESTPHP', issuer: ISSUER };
const USDC = { code: 'USDC', issuer: S.Keypair.random().publicKey() };
/** The sender's payment account: the transaction source of every payment it signs. */
const PAY = S.Keypair.random().publicKey();
const CORRIDOR: Corridor = { from: { country: 'MX', currency: 'MXN' }, to: { country: 'PH', currency: 'PHP' } };
const T0 = 1_800_000_000_000;

class FakeGateway implements StellarGateway {
  route: PathResult | null = { path: [USDC], source: fromDecimal(MXN, '329.3190139') };
  deposits: (Deposit & { memo: string })[] = [];
  trusts = true;
  outcomes: SubmitOutcome[] = [];
  landed = new Map<string, 'SUCCESS' | 'FAILED'>();
  landedCodes = new Map<string, string>();
  /** Simulates a Horizon replica that has not ingested the latest ledger yet. */
  horizonLagging = false;
  submits = 0;
  /** The sender's spendable TESTMXN; null = no account or no trustline. */
  balance: Money | null = fromDecimal(MXN, '10000');
  /** Hash memo per transaction hash, as Horizon reports it. */
  memos = new Map<string, string>();
  findDepositCalls = 0;

  async findStrictReceivePath() { return this.route; }
  async accountBalance() { return this.balance; }
  async findDeposit({ since, memo }: { since: number; memo?: string }) {
    this.findDepositCalls++;
    return this.deposits.find((d) => d.at >= since && (memo === undefined || d.memo === memo)) ?? null;
  }
  async accountTrusts() { return this.trusts; }
  /** The payment account's current sequence, as Horizon would report it; null = no such account (merged). */
  senderSequence: bigint | null = 0n;
  /** Accounts whose sequence was read, in order. */
  sequenceReads: string[] = [];
  async accountSequence(account: string) { this.sequenceReads.push(account); return this.senderSequence; }
  /** The sender's payment account; null = none (never set up, or merged). */
  paymentAccount: string | null = PAY;
  async paymentAccountOf() { return this.paymentAccount; }
  /** Other accounts the chain reports as payment accounts of the sender (S1-1: not the lowest id). */
  morePaymentAccounts: string[] = [];
  async isPaymentAccountOf(account: string) { return account === this.paymentAccount || this.morePaymentAccounts.includes(account); }
  /** Fee-bump envelope hash per inner hash, as Horizon reports it for a landed payment. */
  outer = new Map<string, string>();
  async getTransaction(hash: string) {
    const s = this.horizonLagging ? undefined : this.landed.get(hash);
    const memo = this.memos.get(hash);
    return s
      ? { status: s, ledger: 1, codes: this.landedCodes.get(hash), hash: this.outer.get(hash), ...(memo ? { memoHash: memo } : {}) }
      : { status: 'NOT_FOUND' as const };
  }
  async submitPayment(xdr: string): Promise<SubmitOutcome> {
    this.submits++;
    const inner = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
    const hash = Array.from(inner.hash(), (b) => b.toString(16).padStart(2, '0')).join('');
    const out = this.outcomes.shift() ?? { kind: 'success', hash, ledger: 1 };
    if (out.kind === 'success') this.landed.set(hash, 'SUCCESS');
    if (out.kind === 'cap_exceeded') this.landed.set(hash, 'FAILED');
    if (out.kind === 'failed' && out.hash) {
      this.landed.set(hash, 'FAILED');
      this.landedCodes.set(hash, String((out.codes as any)?.operations?.[0] ?? 'tx_failed'));
    }
    return out;
  }
}

let t: number;
let gw: FakeGateway;
let store: InMemorySagaStore;
let saga: ReturnType<typeof createSaga>;
const sender = S.Keypair.random();
const recipient = S.Keypair.random().publicKey();
let ids = 0;
let logs: ({ evt: string } & Record<string, unknown>)[];

beforeEach(() => {
  t = T0;
  ids = 0;
  logs = [];
  gw = new FakeGateway();
  store = new InMemorySagaStore(() => t);
  saga = createSaga({
    store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER,
    anchorDistribution: ANCHOR, anchorId: 'corra-anchor', now: () => t,
    newId: (p) => `${p}_${++ids}`, log: (l) => logs.push(l),
  });
});

const getQuote = () => saga.quote({ corridor: CORRIDOR, destAmount: fromDecimal(PHP, '1000') });

let seq = 100;
function sign(q: { dest: Money; maxSend: Money; path: AssetId[] }, over: { recipient?: string; sendMax?: Money } = {}) {
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: String(seq++),
    recipient: over.recipient ?? recipient, dest: q.dest, sendMax: over.sendMax ?? q.maxSend,
    path: q.path, now: Math.floor(t / 1000),
  });
  tx.sign(sender);
  return tx.toXDR();
}

async function confirmed(idemKey = 'idem-1') {
  const q = await getQuote();
  const p = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q), idemKey });
  return { q, p };
}

/** The anchor pays the sender, tagging its payment with the SEP-24 memo of `paymentId`. */
const cashIn = async (paymentId: string, amount: Money, at = t) =>
  gw.deposits.push({ hash: `dep_${gw.deposits.length}`, amount, at, memo: await cashInMemo(paymentId) });

const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { return (e as SagaError).code; }
  return 'NO_ERROR';
};

describe('T1 golden path', () => {
  it('QUOTED -> SIGNED -> CASH_IN -> ONCHAIN -> CREDITED with a gapless timeline', async () => {
    const { q, p } = await confirmed();
    expect(p.state).toBe('SIGNED');
    expect(p.kind).toBe('cash_in');
    expect(p.signedXdr).toBeTruthy();

    expect((await saga.reconcile(p.id)).state).toBe('SIGNED'); // no cash-in yet: nothing moves

    await saga.linkCashIn(p.id, 'anchor-tx-1');
    await cashIn(p.id, q.maxSend);
    const done = await saga.onCashIn({ ref: 'anchor-tx-1', kind: 'deposit', status: 'CONFIRMED', at: t, raw: {} });

    expect(done!.state).toBe('CREDITED');
    expect(done!.signedXdr).toBeNull();
    expect(done!.legs.find((l) => l.kind === 'cash_in')).toMatchObject({ status: 'CONFIRMED', txHash: 'dep_0', externalRef: 'anchor-tx-1' });
    expect(done!.legs.find((l) => l.kind === 'onchain')).toMatchObject({ status: 'CONFIRMED', txHash: done!.innerTxHash });
    expect(done!.legs.find((l) => l.kind === 'onchain')!.amount).toEqual(q.dest);

    const ev = await saga.events(p.id);
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(ev.map((e) => e.type)).toEqual(['QUOTED', 'SIGNED', 'CASH_IN', 'ONCHAIN', 'CREDITED']);
    expect(ev.at(-1)!.data).toMatchObject({ ledger: 1 });
  });

  it('a deposit meant for another pending payment of the same sender settles only that one', async () => {
    // Regression: found on testnet. A stale SIGNED payment claimed the deposit of a newer one.
    const { p: stale } = await confirmed('idem-stale');
    const q2 = await getQuote();
    const fresh = await saga.confirm(q2.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q2), idemKey: 'idem-fresh' });
    await cashIn(fresh.id, q2.maxSend);

    // The stale one was superseded when the newer one was confirmed, and the newer deposit
    // (tagged with the newer payment's memo) can never revive or settle it.
    const after = await saga.reconcile(stale.id);
    expect(after.state).toBe('EXPIRED');
    expect(after.signedXdr).toBeNull();
    expect((await saga.reconcile(fresh.id)).state).toBe('CREDITED');
    expect(gw.submits).toBe(1);
  });

  it('does not advance on a deposit smaller than the signed cap', async () => {
    const { p } = await confirmed();
    await cashIn(p.id, fromDecimal(MXN, '1'));
    expect((await saga.reconcile(p.id)).state).toBe('SIGNED');
    expect(gw.submits).toBe(0);
  });
});

describe('T2 cap exceeded', () => {
  it('ONCHAIN -> CAP_EXCEEDED, blob deleted, and only a new saga can retry', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'cap_exceeded', hash: 'failed_tx', codes: { operations: ['op_over_source_max'] } });
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('CAP_EXCEEDED');
    expect(done.signedXdr).toBeNull();
    expect(done.legs.find((l) => l.kind === 'onchain')).toMatchObject({ status: 'FAILED', txHash: 'failed_tx' });
    expect(isTerminal(done.state)).toBe(true);

    const q2 = await getQuote();
    const retry = await saga.resign(p.id, q2.id, sign(q2), 'idem-retry');
    expect(retry.supersedesId).toBe(p.id);
    expect(retry.id).not.toBe(p.id);
    expect((await saga.getPayment(p.id)).state).toBe('CAP_EXCEEDED');
  });

  it('refuses to re-sign a payment that is not terminal-failed', async () => {
    const { p } = await confirmed();
    const q2 = await getQuote();
    expect(await code(() => saga.resign(p.id, q2.id, sign(q2), 'idem-x'))).toBe('NOT_RESIGNABLE');
  });
});

describe('T3 no route', () => {
  it('quote fails with NO_PATH and stores nothing', async () => {
    gw.route = null;
    expect(await code(getQuote)).toBe('NO_PATH');
    expect(await store.getQuote('qt_1')).toBeNull();
  });
});

describe('T4 lost callback', () => {
  it('the reconciler confirms cash-in from chain state and settles without any callback', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    t += 31_000;
    expect(await saga.reconcileAll(30_000)).toBe(1);
    expect((await saga.getPayment(p.id)).state).toBe('CREDITED');
  });
});

describe('T5 duplicate callback', () => {
  it('a repeated or concurrent callback submits once and writes no duplicate events', async () => {
    const { q, p } = await confirmed();
    await saga.linkCashIn(p.id, 'anchor-tx-1');
    await cashIn(p.id, q.maxSend);
    const ev = { ref: 'anchor-tx-1', kind: 'deposit' as const, status: 'CONFIRMED' as const, at: t, raw: {} };
    await Promise.all([saga.onCashIn(ev), saga.onCashIn(ev)]);
    await saga.onCashIn(ev);
    expect(gw.submits).toBe(1);
    expect((await saga.events(p.id)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a callback for an unknown reference is ignored', async () => {
    expect(await saga.onCashIn({ ref: 'nope', kind: 'deposit', status: 'CONFIRMED', at: t, raw: {} })).toBeNull();
  });
});

describe('T6 quote expired', () => {
  it('confirm after the TTL is QUOTE_EXPIRED and creates no payment', async () => {
    const q = await getQuote();
    t += 121_000; // quotes live 2 minutes
    expect(await code(() => saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q), idemKey: 'k' }))).toBe('QUOTE_EXPIRED');
    expect(await store.getPaymentByIdemKey('k')).toBeNull();
  });
});

describe('SEP-38 pass-through', () => {
  it("records the anchor's firm quote id and expiry on the payment, unchanged", async () => {
    const q = await getQuote();
    const p = await saga.confirm(q.id, {
      sender: sender.publicKey(), recipient, signedXdr: sign(q), idemKey: 'k-aq',
      anchorQuote: { id: '5d9afff9-65bd-430f-8455-8ab2ee0cdb60', expiresAt: 1_800_000_003_600_000 },
    });
    expect(p.quote.anchorQuoteId).toBe('5d9afff9-65bd-430f-8455-8ab2ee0cdb60');
    expect(p.quote.anchorQuoteExpiresAt).toBe(1_800_000_003_600_000);
    expect(p.quote.maxSend).toEqual(q.maxSend);
  });
});

describe('T7 idempotent confirm', () => {
  it('the same key returns the same payment; a second key on the same quote is refused', async () => {
    const q = await getQuote();
    const xdr = sign(q);
    const a = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey: 'same' });
    const b = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey: 'same' });
    expect(b.id).toBe(a.id);
    expect(await code(() => saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey: 'other' }))).toBe('QUOTE_USED');
  });
});

describe('T8 unbound transaction', () => {
  it('refuses a signed blob that does not match the quote', async () => {
    const q = await getQuote();
    const wrongDest = sign(q, { recipient: S.Keypair.random().publicKey() });
    const wrongCap = sign(q, { sendMax: fromDecimal(MXN, '999999') });
    for (const signedXdr of [wrongDest, wrongCap, 'garbage']) {
      expect(await code(() => saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr, idemKey: signedXdr.slice(0, 20) }))).toBe('UNBOUND_TRANSACTION');
    }
  });
});

describe('T9 illegal transitions', () => {
  it('only the documented transitions are allowed', () => {
    expect(isAllowedTransition('SIGNED', 'CASH_IN')).toBe(true);
    expect(isAllowedTransition('CREDITED', 'ONCHAIN')).toBe(false);
    expect(isAllowedTransition('EXPIRED', 'SIGNED')).toBe(false);
    expect(isAllowedTransition('QUOTED', 'CREDITED')).toBe(false);
  });

  it('a transition from a stale state is a no-op', async () => {
    const { p } = await confirmed();
    expect(await store.transition(p.id, 'CASH_IN', 'ONCHAIN', {}, { type: 'ONCHAIN', from: 'CASH_IN', to: 'ONCHAIN' })).toBeNull();
    expect((await saga.getPayment(p.id)).state).toBe('SIGNED');
  });
});

describe('T10 recipient trustline preflight', () => {
  it('confirm is refused before anything is stored when the recipient cannot receive', async () => {
    gw.trusts = false;
    const q = await getQuote();
    expect(await code(() => saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q), idemKey: 'k' }))).toBe('RECIPIENT_NO_TRUSTLINE');
    expect(await store.getPaymentByIdemKey('k')).toBeNull();
  });
});

describe('timebound expiry', () => {
  it('SIGNED -> EXPIRED once maxTime and the grace period pass, the blob is deleted, nothing is submitted', async () => {
    const { p } = await confirmed();
    t += 31 * 60_000;
    expect((await saga.reconcile(p.id)).state).toBe('SIGNED'); // inside the grace period
    t += 2 * 60_000;
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('EXPIRED');
    expect(done.signedXdr).toBeNull();
    expect(gw.submits).toBe(0);
  });

  it('CASH_IN -> EXPIRED when the submission lands after maxTime', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'expired', codes: { inner_transaction: 'tx_too_late' } });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN'); // never expired on a rejection alone
    t = p.maxTime * 1000 + 3 * 60_000;
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('EXPIRED');
    expect((await saga.events(p.id)).at(-1)!.data).toMatchObject({ reason: 'maxTime passed before the payment landed' });
  });

  it('a bad_seq after a concurrent submission already landed is settled, not expired', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'bad_seq', codes: {} });
    gw.landed.set(p.innerTxHash, 'SUCCESS');
    // Simulate the other submitter winning between our getTransaction and submit.
    const real = gw.getTransaction.bind(gw);
    let first = true;
    gw.getTransaction = async (h) => (first ? ((first = false), { status: 'NOT_FOUND' as const }) : real(h));
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    expect((await saga.reconcile(p.id)).state).toBe('CREDITED');
  });
});

describe('audit regressions', () => {
  const GRACE_MS = 120_000;
  const pastDeadline = (p: { maxTime: number }) => { t = p.maxTime * 1000 + GRACE_MS + 1000; };

  it('a lagging Horizon cannot turn a landed payment into EXPIRED', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    // Another process already landed the payment; this process sees bad_seq and a stale Horizon.
    gw.landed.set(p.innerTxHash, 'SUCCESS');
    gw.horizonLagging = true;
    gw.outcomes.push({ kind: 'bad_seq', codes: {} });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    gw.horizonLagging = false;
    expect((await saga.reconcile(p.id)).state).toBe('CREDITED');
  });

  it('a submission that keeps failing transiently expires once maxTime and a grace period have passed', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    for (let i = 0; i < 3; i++) gw.outcomes.push({ kind: 'failed', codes: { transaction: 'tx_insufficient_fee' } });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    t = p.maxTime * 1000 + 1000; // past maxTime but inside the grace period: still waiting
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    pastDeadline(p);
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('EXPIRED');
    expect(done.signedXdr).toBeNull();
  });

  it('a blob the sender submitted themselves settles from SIGNED instead of expiring', async () => {
    const { p } = await confirmed();
    gw.landed.set(p.innerTxHash, 'SUCCESS');
    pastDeadline(p);
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('CREDITED');
    expect(gw.submits).toBe(0);
  });

  it('a payment that landed failed for a reason other than the cap is FAILED with its code kept', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'failed', hash: 'h', codes: { operations: ['op_underfunded'] } });
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('FAILED');
    expect((await saga.events(p.id)).at(-1)!.data).toMatchObject({ codes: 'op_underfunded' });
  });

  it('an expired payment does not leave its cash-in leg pending', async () => {
    const { p } = await confirmed();
    pastDeadline(p);
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('EXPIRED');
    expect(done.legs.find((l) => l.kind === 'cash_in')!.status).toBe('FAILED');
  });

  it('a newer payment from the same sender supersedes an older one still waiting for cash-in', async () => {
    const { p: old } = await confirmed('idem-old');
    const q2 = await getQuote();
    const fresh = await saga.confirm(q2.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q2), idemKey: 'idem-new' });
    expect(fresh.state).toBe('SIGNED');
    const before = await saga.getPayment(old.id);
    expect(before.state).toBe('EXPIRED');
    expect((await saga.events(old.id)).at(-1)!.data).toMatchObject({ reason: 'superseded by a newer payment' });
  });

  it('a new payment is refused while one from the same sender is already being settled', async () => {
    const { q, p } = await confirmed('idem-busy');
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'failed', codes: {} }); // stays CASH_IN
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    const q2 = await getQuote();
    expect(await code(() => saga.confirm(q2.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q2), idemKey: 'idem-2' }))).toBe('PAYMENT_IN_PROGRESS');
  });

  it('reusing an idempotency key for a different request is refused', async () => {
    const { p } = await confirmed('idem-reuse');
    const q2 = await getQuote();
    expect(await code(() => saga.confirm(q2.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q2), idemKey: 'idem-reuse' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await saga.findByIdemKey('idem-reuse'))!.id).toBe(p.id);
  });

  it('two concurrent confirms with one key and different recipients: one is created, the other is IDEMPOTENCY_KEY_REUSED', async () => {
    const [q1, q2] = [await getQuote(), await getQuote()];
    const other = S.Keypair.random().publicKey();
    const rs = await Promise.allSettled([
      saga.confirm(q1.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q1), idemKey: 'idem-race' }),
      saga.confirm(q2.id, { sender: sender.publicKey(), recipient: other, signedXdr: sign(q2, { recipient: other }), idemKey: 'idem-race' }),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('a cash-in reference is write-once', async () => {
    const { p } = await confirmed();
    await saga.linkCashIn(p.id, 'ref-1');
    await saga.linkCashIn(p.id, 'ref-1');
    expect(await code(() => saga.linkCashIn(p.id, 'ref-2'))).toBe('CASH_IN_ALREADY_LINKED');
  });

  it('one signed transaction can never back two payments', async () => {
    const q1 = await getQuote();
    const xdr = sign(q1);
    await saga.confirm(q1.id, { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey: 'k-a' });
    const q2 = await getQuote(); // same amount, same book: the same signed XDR also binds to it
    expect(await code(() => saga.confirm(q2.id, { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey: 'k-b' }))).toBe('DUPLICATE_TRANSACTION');
  });

  it('a re-sign reuses the cash-in of the payment it replaces instead of asking for a new one', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'bad_seq', codes: {} });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    pastDeadline(p);
    expect((await saga.reconcile(p.id)).state).toBe('EXPIRED');

    const q2 = await getQuote();
    const p2 = await saga.resign(p.id, q2.id, sign(q2), 'idem-resign');
    const done = await saga.reconcile(p2.id); // no deposit carries p2's memo
    expect(done.state).toBe('CREDITED');
    expect(gw.deposits).toHaveLength(1);
  });

  it('a fresh payment does not count the deposit of an unrelated expired one', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'bad_seq', codes: {} });
    await saga.reconcile(p.id);
    pastDeadline(p);
    expect((await saga.reconcile(p.id)).state).toBe('EXPIRED');
    const q2 = await getQuote();
    const p2 = await saga.confirm(q2.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q2), idemKey: 'idem-new' });
    expect((await saga.reconcile(p2.id)).state).toBe('SIGNED');
  });

  it('a payment whose sequence the sender used up expires before any cash-in, with the reason', async () => {
    const { p } = await confirmed();
    const txSeq = BigInt((S.TransactionBuilder.fromXDR(p.signedXdr!, NP) as S.Transaction).sequence);
    gw.senderSequence = txSeq - 1n; // still inside the window
    expect((await saga.reconcile(p.id)).state).toBe('SIGNED');
    gw.senderSequence = txSeq; // the sender's own transactions consumed it
    expect((await saga.reconcile(p.id)).state).toBe('SIGNED'); // first sight: wait out Horizon lag
    t += GRACE_MS;
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('EXPIRED');
    const ev = await store.events(p.id);
    expect(ev.at(-1)?.data).toMatchObject({ reason: 'payment account sequence left the signing window' });
  });

  it('a lagging Horizon cannot expire a landed payment and let a re-sign spend its deposit again', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    const txSeq = BigInt((S.TransactionBuilder.fromXDR(p.signedXdr!, NP) as S.Transaction).sequence);
    // It landed, but this Horizon node has not ingested it yet while another reports the sequence used.
    gw.landed.set(p.innerTxHash, 'SUCCESS');
    gw.horizonLagging = true;
    gw.senderSequence = txSeq;
    gw.outcomes.push({ kind: 'bad_seq', codes: {} });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN'); // not expired on first sight
    gw.horizonLagging = false;
    expect((await saga.reconcile(p.id)).state).toBe('CREDITED');
  });

  it('a re-sign never reuses the deposit of an EXPIRED payment whose blob did land', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'bad_seq', codes: {} });
    await saga.reconcile(p.id);
    pastDeadline(p);
    expect((await saga.reconcile(p.id)).state).toBe('EXPIRED');
    const q2 = await getQuote();
    const p2 = await saga.resign(p.id, q2.id, sign(q2), 'idem-rs');
    gw.landed.set(p.innerTxHash, 'SUCCESS'); // the ledger was wrong: it landed after all
    expect((await saga.reconcile(p2.id)).state).toBe('SIGNED'); // no new deposit, so nothing to settle with
  });

  it('superseding a payment whose blob already landed settles it instead of expiring it', async () => {
    const { p } = await confirmed();
    gw.landed.set(p.innerTxHash, 'SUCCESS'); // the sender submitted it themselves
    const q2 = await getQuote();
    await saga.confirm(q2.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q2), idemKey: 'idem-new2' });
    expect((await store.getPayment(p.id))!.state).toBe('CREDITED');
  });

  it('C1 CREDITED: the onchain leg CONFIRMED and a PENDING cash_out leg (dest amount, anchor, no ref); no payoutRef', async () => {
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('CREDITED');
    expect(done.legs.find((l) => l.kind === 'onchain')).toMatchObject({ status: 'CONFIRMED', txHash: p.innerTxHash });
    const leg = done.legs.find((l) => l.kind === 'cash_out')!;
    expect(leg).toEqual({ kind: 'cash_out', status: 'PENDING', amount: q.dest, anchorId: 'corra-anchor' });
    const credited = (await store.events(p.id)).at(-1)!;
    expect(credited).toMatchObject({ type: 'CREDITED', from: 'ONCHAIN', to: 'CREDITED', data: { txHash: p.innerTxHash, ledger: 1 } });
    expect(credited.data).not.toHaveProperty('payoutRef');
  });

  it('records the fee-bump envelope hash Horizon reports, also when the reconciler settles', async () => {
    const { p } = await confirmed();
    gw.landed.set(p.innerTxHash, 'SUCCESS');
    gw.outer.set(p.innerTxHash, 'outer-hash');
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('CREDITED');
    expect(done.legs.find((l) => l.kind === 'onchain')?.txHash).toBe('outer-hash');
  });

  it('a signed transaction that already landed cannot back a new payment', async () => {
    const q = await getQuote();
    const xdr = sign(q);
    const inner = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
    gw.landed.set(Array.from(inner.hash(), (b) => b.toString(16).padStart(2, '0')).join(''), 'SUCCESS');
    expect(await code(() => saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey: 'k-c' }))).toBe('DUPLICATE_TRANSACTION');
  });

  it('public ids are 6 characters from an unambiguous alphabet', async () => {
    const { p } = await confirmed();
    expect(p.publicId).toMatch(/^CORRA-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });
});

describe('balance payments (D1)', () => {
  const hashOf = (xdr: string) =>
    Array.from((S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction).hash(), (b) => b.toString(16).padStart(2, '0')).join('');

  /** The payment account's next transaction, built from what Horizon reports as its current sequence. */
  function signBalance(q: { dest: Money; maxSend: Money; path: AssetId[] }, over: { senderSequence?: bigint; recipient?: string } = {}) {
    const tx = buildStrictReceive({
      networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: String(over.senderSequence ?? gw.senderSequence),
      recipient: over.recipient ?? recipient, dest: q.dest, sendMax: q.maxSend, path: q.path, now: Math.floor(t / 1000), mode: 'balance',
    });
    tx.sign(sender);
    return tx.toXDR();
  }

  const send = async (idemKey = 'send-1') => {
    const q = await getQuote();
    const xdr = signBalance(q);
    const p = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey, kind: 'balance' });
    return { q, p, xdr };
  };

  beforeEach(() => {
    gw.senderSequence = 5000n;
    seq = 5000; // Phase 1 payments in these tests sign inside the sender's live window
  });

  it('T11 golden path: created in CASH_IN with a marker leg, settled in one submission', async () => {
    const { q, p } = await send();
    expect(p).toMatchObject({ kind: 'balance', state: 'CASH_IN' });
    const marker = p.legs.find((l) => l.kind === 'cash_in')!;
    expect(marker).toMatchObject({ status: 'CONFIRMED', externalRef: `balance:${p.publicId}`, amount: q.maxSend });
    expect(marker).not.toHaveProperty('anchorId');
    const created = await saga.events(p.id);
    expect(created.map((e) => e.type)).toEqual(['QUOTED', 'SIGNED', 'CASH_IN']);
    expect(created.at(-1)!.data).toEqual({ source: 'balance', balance: '10000.0000000' });
    // Every edge of the one write is in the unchanged transition table.
    for (const e of created.slice(1)) expect(isAllowedTransition(e.from!, e.to!)).toBe(true);
    expect(gw.submits).toBe(0);

    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('CREDITED');
    expect(done.signedXdr).toBeNull();
    expect(done.legs.find((l) => l.kind === 'onchain')).toMatchObject({ status: 'CONFIRMED' });
    expect(done.legs.find((l) => l.kind === 'cash_out')).toEqual({ kind: 'cash_out', status: 'PENDING', amount: q.dest, anchorId: 'corra-anchor' });
    const ev = await saga.events(p.id);
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(ev[3]).toMatchObject({ type: 'ONCHAIN', data: { ledger: 1 } });
    expect(ev[4]).toMatchObject({ type: 'CREDITED', data: { ledger: 1 } });
    expect(gw.submits).toBe(1);
    expect(gw.findDepositCalls).toBe(0);
    expect(logs.map((l) => l.evt)).toEqual(['send.created', 'send.settled']);
  });

  it('T12 insufficient balance is refused before any row, and retriable', async () => {
    const q = await getQuote();
    const xdr = signBalance(q);
    const input = { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey: 'k-low', kind: 'balance' as const };
    gw.balance = { asset: q.maxSend.asset, raw: q.maxSend.raw - 1n };
    const err = await saga.confirm(q.id, input).catch((e) => e as SagaError);
    expect(err).toMatchObject({ code: 'INSUFFICIENT_BALANCE', retriable: true });
    expect((err as SagaError).message).toContain(`have ${toDecimal(gw.balance)}, the payment needs up to ${toDecimal(q.maxSend)}`);
    gw.balance = null;
    expect(await code(() => saga.confirm(q.id, input))).toBe('INSUFFICIENT_BALANCE');
    expect(await saga.findByIdemKey('k-low')).toBeNull();
    gw.balance = q.maxSend;
    expect((await saga.confirm(q.id, input)).state).toBe('CASH_IN');
  });

  it('T13 op_underfunded on chain lands FAILED with its code', async () => {
    const { p } = await send();
    gw.outcomes.push({ kind: 'failed', hash: 'h-under', codes: { operations: ['op_underfunded'] } });
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('FAILED');
    expect(done.signedXdr).toBeNull();
    expect(done.legs.find((l) => l.kind === 'onchain')!.status).toBe('FAILED');
    expect((await saga.events(p.id)).at(-1)!.data).toMatchObject({ codes: 'op_underfunded' });
    expect(logs.at(-1)).toMatchObject({ evt: 'send.failed', codes: 'op_underfunded' });
  });

  it('T14 refused while another payment of the sender is CASH_IN or ONCHAIN', async () => {
    // (a) a Phase 1 payment held in CASH_IN
    const { q, p } = await confirmed('p1');
    await cashIn(p.id, q.maxSend);
    gw.outcomes.push({ kind: 'failed', codes: {} });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    expect(await code(() => send('b-a'))).toBe('PAYMENT_IN_PROGRESS');
    // (b) a balance payment in CASH_IN blocks a second one
    beforeFresh();
    await send('b-1');
    expect(await code(() => send('b-2'))).toBe('PAYMENT_IN_PROGRESS');
    // (c) and blocks a Phase 1 /confirm
    expect(await code(() => confirmed('p2'))).toBe('PAYMENT_IN_PROGRESS');
  });

  /** A fresh saga and store on the same gateway settings. */
  function beforeFresh() {
    store = new InMemorySagaStore(() => t);
    saga = createSaga({
      store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER,
      anchorDistribution: ANCHOR, anchorId: 'corra-anchor', now: () => t, newId: (p) => `${p}_${++ids}`,
    });
  }

  it('T15 a SIGNED pre-signed payment blocks a balance payment until it is credited, and is never superseded by one (M2)', async () => {
    // Its blob (payment account + 100, minSeqNum) would stay valid after a balance blob landed at + 1: both could land.
    const { q: q1, p: p1 } = await confirmed('p1');
    const err = await send().catch((e) => e as SagaError);
    expect(err).toMatchObject({ code: 'SIGNED_PAYMENT_WAITING', status: 409, retriable: true });
    expect(await saga.findByIdemKey('send-1')).toBeNull();
    const still = await saga.getPayment(p1.id);
    expect(still.state).toBe('SIGNED');
    expect(still.signedXdr).toBeTruthy();
    expect((await saga.events(p1.id)).map((e) => e.type)).not.toContain('EXPIRED');
    await cashIn(p1.id, q1.maxSend);
    expect((await saga.reconcile(p1.id)).state).toBe('CREDITED');
    // Credited: the balance flow is open again.
    gw.senderSequence = 5001n;
    const { p } = await send('send-2');
    expect((await saga.reconcile(p.id)).state).toBe('CREDITED');
  });

  it('T15b a pre-signed payment that was superseded or expired no longer blocks a balance payment', async () => {
    const { p: p1 } = await confirmed('p1');
    t = (p1.maxTime + 121) * 1000;
    expect((await saga.reconcile(p1.id)).state).toBe('EXPIRED');
    const { p } = await send();
    expect(p.state).toBe('CASH_IN');
  });

  it('T16a two balance payments of one sender settle one after the other with distinct markers', async () => {
    const { p: a } = await send('s-a');
    expect((await saga.reconcile(a.id)).state).toBe('CREDITED');
    gw.senderSequence = 5001n;
    const { p: b } = await send('s-b');
    expect((await saga.reconcile(b.id)).state).toBe('CREDITED');
    const markers = [a, b].map((p) => p.legs.find((l) => l.kind === 'cash_in')!);
    expect(markers.map((m) => m.externalRef)).toEqual([`balance:${a.publicId}`, `balance:${b.publicId}`]);
    expect(new Set(markers.map((m) => m.externalRef)).size).toBe(2);
    for (const m of markers) expect(m).not.toHaveProperty('anchorId');
  });

  it('T18 a replay returns the same payment; a key of the other kind is refused', async () => {
    const q1 = await getQuote();
    const p1 = await saga.confirm(q1.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q1), idemKey: 'k-p1' });
    expect(await code(() => saga.confirm(q1.id, { sender: sender.publicKey(), recipient, signedXdr: signBalance(q1), idemKey: 'k-p1', kind: 'balance' }))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await saga.findByIdemKey('k-p1'))!.id).toBe(p1.id);

    beforeFresh(); // T15: the SIGNED p1 would block the balance payment below
    const q = await getQuote();
    const input = { sender: sender.publicKey(), recipient, signedXdr: signBalance(q), idemKey: 'k-r', kind: 'balance' as const };
    const a = await saga.confirm(q.id, input);
    const b = await saga.confirm(q.id, input);
    expect(b.id).toBe(a.id);
    expect(await saga.events(a.id)).toHaveLength(3);
    expect(await code(() => saga.confirm(q.id, { ...input, kind: undefined }))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it("T19 a stale sequence is refused and nothing is stored", async () => {
    const q = await getQuote();
    const xdr = signBalance(q); // from 5000
    const input = { sender: sender.publicKey(), recipient, signedXdr: xdr, idemKey: 'k-seq', kind: 'balance' as const };
    gw.senderSequence = 5001n;
    const e = await saga.confirm(q.id, input).catch((x) => x as SagaError);
    expect(e).toMatchObject({ code: 'UNBOUND_TRANSACTION' });
    expect((e as SagaError).message).toMatch(/payment account's next/);
    gw.senderSequence = null;
    expect(await code(() => saga.confirm(q.id, input))).toBe('UNBOUND_TRANSACTION');
    expect(await saga.findByIdemKey('k-seq')).toBeNull();
  });

  it('T20 a payment that never lands expires after maxTime and the grace period, marker kept', async () => {
    const { p } = await send();
    for (let i = 0; i < 3; i++) gw.outcomes.push({ kind: 'failed', codes: { transaction: 'tx_insufficient_fee' } });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    t = (p.maxTime + 120) * 1000;
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('EXPIRED');
    expect(done.signedXdr).toBeNull();
    expect(done.legs.find((l) => l.kind === 'cash_in')!.status).toBe('CONFIRMED');
  });

  it('T21 bad_seq after the sender used the sequence expires with SEQUENCE_GONE', async () => {
    const { p, xdr } = await send();
    gw.senderSequence = BigInt((S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction).sequence);
    gw.outcomes.push({ kind: 'bad_seq', codes: {} }, { kind: 'bad_seq', codes: {} });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN'); // first sight: wait out Horizon lag
    t += 120_000;
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('EXPIRED');
    expect((await saga.events(p.id)).at(-1)!.data).toMatchObject({ reason: 'payment account sequence left the signing window' });
  });

  it('T22 a blob the sender submitted themselves settles without a submission', async () => {
    const { p, xdr } = await send();
    gw.landed.set(hashOf(xdr), 'SUCCESS');
    expect((await saga.reconcile(p.id)).state).toBe('CREDITED');
    expect(gw.submits).toBe(0);
  });

  it('T23 re-signing a FAILED balance payment creates a balance payment', async () => {
    const { p: old } = await send();
    gw.outcomes.push({ kind: 'failed', hash: 'h-f', codes: { operations: ['op_underfunded'] } });
    expect((await saga.reconcile(old.id)).state).toBe('FAILED');
    gw.senderSequence = 5001n; // the failed transaction used its sequence
    const q2 = await getQuote();
    const p2 = await saga.resign(old.id, q2.id, signBalance(q2), 'k-rs');
    expect(p2).toMatchObject({ kind: 'balance', supersedesId: old.id, state: 'CASH_IN' });
    const q3 = await getQuote();
    expect(await code(() => saga.resign(old.id, q3.id, sign(q3), 'k-rs2'))).toBe('UNBOUND_TRANSACTION');
  });

  it('T24 a balance payment has no anchor cash-in to link', async () => {
    const { p } = await send();
    expect(await code(() => saga.linkCashIn(p.id, 'x'))).toBe('CASH_IN_ALREADY_LINKED');
  });

  it('T25 two concurrent balance sends: one is created, the other is PAYMENT_IN_PROGRESS', async () => {
    const [q1, q2] = [await getQuote(), await getQuote()];
    // Two recipients, so the two blobs at the same sequence differ.
    const input = (q: typeof q1, k: string, to: string) =>
      ({ sender: sender.publicKey(), recipient: to, signedXdr: signBalance(q, { recipient: to }), idemKey: k, kind: 'balance' as const });
    const rs = await Promise.allSettled([
      saga.confirm(q1.id, input(q1, 'c-1', recipient)),
      saga.confirm(q2.id, input(q2, 'c-2', S.Keypair.random().publicKey())),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'PAYMENT_IN_PROGRESS' });
  });

  it('T25b two concurrent balance sends with one key and different recipients: one is created, the other is IDEMPOTENCY_KEY_REUSED', async () => {
    const [q1, q2] = [await getQuote(), await getQuote()];
    const other = S.Keypair.random().publicKey();
    const input = (q: typeof q1, to: string) =>
      ({ sender: sender.publicKey(), recipient: to, signedXdr: signBalance(q, { recipient: to }), idemKey: 'c-same', kind: 'balance' as const });
    const rs = await Promise.allSettled([saga.confirm(q1.id, input(q1, recipient)), saga.confirm(q2.id, input(q2, other))]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(logs.filter((l) => l.evt === 'send.created')).toHaveLength(1);
  });
});

describe('payment account (spec-varial-fix)', () => {
  it('a payment is refused when the sender has no payment account, before any row', async () => {
    gw.paymentAccount = null;
    const q = await getQuote();
    const e = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q), idemKey: 'k-none' }).catch((x) => x as SagaError);
    expect(e).toMatchObject({ code: 'UNBOUND_TRANSACTION', message: "source is not the sender's payment account: set up the account first if you have none" });
    gw.senderSequence = 5000n;
    const bal = buildStrictReceive({
      networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: '5001', recipient,
      dest: q.dest, sendMax: q.maxSend, path: q.path, now: Math.floor(t / 1000), mode: 'balance',
    });
    bal.sign(sender);
    const b = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: bal.toXDR(), idemKey: 'k-none-b', kind: 'balance' })
      .catch((x) => x as SagaError);
    expect(b).toMatchObject({ code: 'UNBOUND_TRANSACTION', message: "source is not the sender's payment account: set up the account first if you have none" });
    expect(await saga.findByIdemKey('k-none')).toBeNull();
  });

  it('S5-2a a refused blob the sender signed costs one account read: the ?signer= listing is never walked', async () => {
    const calls: string[] = [];
    const counting = new Proxy(gw, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? (...args: unknown[]) => { calls.push(String(prop)); return v.apply(target, args); } : v;
      },
    });
    const s2 = createSaga({
      store, gateway: counting, networkPassphrase: NP, corridorIssuer: ISSUER,
      anchorDistribution: ANCHOR, anchorId: 'corra-anchor', now: () => t, newId: (p) => `${p}_${++ids}`,
    });
    for (const pa of [null, S.Keypair.random().publicKey()]) {
      gw.paymentAccount = pa;
      calls.length = 0;
      const q = await s2.quote({ corridor: CORRIDOR, destAmount: fromDecimal(PHP, '1000') });
      calls.length = 0;
      const e = await s2.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q), idemKey: `k-s52a-${seq}` })
        .catch((x) => x as SagaError);
      expect(e).toMatchObject({ code: 'UNBOUND_TRANSACTION', message: "source is not the sender's payment account: set up the account first if you have none" });
      expect(calls).toEqual(['isPaymentAccountOf']);
    }
  });

  it('C5-1 a sender-signed blob with a muxed M transaction source is refused as unbound with no gateway call', async () => {
    const q = await getQuote();
    // The same blob buildStrictReceive makes, with PAY muxed as the transaction source.
    const base = buildStrictReceive({
      networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: String(seq++), recipient,
      dest: q.dest, sendMax: q.maxSend, path: q.path, now: Math.floor(t / 1000),
    });
    const op = base.operations[0] as S.Operation.PathPaymentStrictReceive;
    const mux = new S.MuxedAccount(new S.Account(PAY, (BigInt(base.sequence) - 1n).toString()), '7');
    const tx = new S.TransactionBuilder(mux, {
      fee: '0', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: Number(base.timeBounds!.maxTime) },
      minAccountSequence: base.minAccountSequence,
    }).addOperation(S.Operation.pathPaymentStrictReceive({
      sendAsset: op.sendAsset, sendMax: op.sendMax, destination: op.destination, destAsset: op.destAsset,
      destAmount: op.destAmount, path: op.path, source: op.source,
    })).build();
    expect(tx.source.startsWith('M')).toBe(true);
    tx.sign(sender);
    const calls: string[] = [];
    // Horizon answers 400 to a muxed account read: the fake does the same, so a read here would be a 500.
    const counting = new Proxy(gw, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function'
          ? (...args: unknown[]) => { calls.push(String(prop)); if (String(args[0]).startsWith('M')) throw new Error('Horizon 400'); return v.apply(target, args); }
          : v;
      },
    });
    const s2 = createSaga({
      store, gateway: counting, networkPassphrase: NP, corridorIssuer: ISSUER,
      anchorDistribution: ANCHOR, anchorId: 'corra-anchor', now: () => t, newId: (p) => `${p}_${++ids}`,
    });
    const e = await s2.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: tx.toXDR(), idemKey: 'k-muxed' })
      .catch((x) => x as SagaError);
    expect(e).toMatchObject({ code: 'UNBOUND_TRANSACTION', message: "source is not the sender's payment account" });
    expect(calls).toEqual([]);
  });

  it('S2-1 a junk, unsigned or wrongly signed blob is refused with no gateway call, on /confirm and /send', async () => {
    const q = await getQuote();
    const calls: string[] = [];
    const counting = new Proxy(gw, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? (...args: unknown[]) => { calls.push(String(prop)); return v.apply(target, args); } : v;
      },
    });
    const s2 = createSaga({
      store, gateway: counting, networkPassphrase: NP, corridorIssuer: ISSUER,
      anchorDistribution: ANCHOR, anchorId: 'corra-anchor', now: () => t, newId: (p) => `${p}_${++ids}`,
    });
    const blob = (mode: 'presigned' | 'balance', signer: S.Keypair | null) => {
      const tx = buildStrictReceive({
        networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: String(seq++), recipient,
        dest: q.dest, sendMax: q.maxSend, path: q.path, now: Math.floor(t / 1000), mode,
      });
      if (signer) tx.sign(signer);
      return tx.toXDR();
    };
    for (const kind of [undefined, 'balance'] as const) {
      const mode = kind ?? 'presigned';
      for (const signedXdr of ['junk', 'AAAA', blob(mode, null), blob(mode, S.Keypair.random())]) {
        const e = await s2.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr, idemKey: `k-junk-${calls.length}-${seq}`, kind })
          .catch((x) => x as SagaError);
        expect(e).toMatchObject({ code: 'UNBOUND_TRANSACTION' });
      }
    }
    expect(calls).toEqual([]);
    // A blob the sender really signed costs one account read for its source, nothing more.
    expect((await s2.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: blob('presigned', sender), idemKey: 'k-real' })).state).toBe('SIGNED');
    expect(calls.filter((c) => c === 'isPaymentAccountOf' || c === 'paymentAccountOf')).toEqual(['isPaymentAccountOf']);
  });

  it('a blob sourced by another account than the sender\'s payment account is refused', async () => {
    gw.paymentAccount = S.Keypair.random().publicKey();
    const q = await getQuote();
    expect(await code(() => saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q), idemKey: 'k-other' })))
      .toBe('UNBOUND_TRANSACTION');
  });

  it('S1-1 a blob sourced by a valid payment account that is not the lowest listed id is accepted', async () => {
    // Someone added the sender as a signer of a lower-id look-alike, or pushed the real one off page 1.
    const other = S.Keypair.random().publicKey();
    gw.paymentAccount = other;
    gw.morePaymentAccounts = [PAY];
    const q = await getQuote();
    const p = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q), idemKey: 'k-not-lowest' });
    expect(p.state).toBe('SIGNED');
    // Not a payment account of the sender: still refused.
    gw.morePaymentAccounts = [];
    const q2 = await getQuote();
    expect(await code(() => saga.confirm(q2.id, { sender: sender.publicKey(), recipient, signedXdr: sign(q2), idemKey: 'k-not-lowest-2' })))
      .toBe('UNBOUND_TRANSACTION');
  });

  it('the balance sequence check reads the payment account, not the sender', async () => {
    gw.senderSequence = 5000n;
    const q = await getQuote();
    const tx = buildStrictReceive({
      networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: '5000', recipient,
      dest: q.dest, sendMax: q.maxSend, path: q.path, now: Math.floor(t / 1000), mode: 'balance',
    });
    tx.sign(sender);
    gw.sequenceReads = [];
    const p = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: tx.toXDR(), idemKey: 'k-seq-z', kind: 'balance' });
    expect(p.state).toBe('CASH_IN');
    expect(gw.sequenceReads).toEqual([PAY]);
  });

  it('sequenceLeftWindow reads the blob\'s own transaction source', async () => {
    const { p } = await confirmed();
    gw.sequenceReads = [];
    expect((await saga.reconcile(p.id)).state).toBe('SIGNED');
    expect(gw.sequenceReads).toEqual([PAY]);
  });

  it('M3 a merged payment account (Horizon 404) is "left the window": SEQUENCE_GONE after the grace, never a throw', async () => {
    const { p } = await confirmed();
    gw.senderSequence = null;
    gw.paymentAccount = null;
    expect((await saga.reconcile(p.id)).state).toBe('SIGNED'); // first sight: wait out Horizon lag
    t += 120_000;
    expect(await saga.reconcileAll(0)).toBe(1);
    const done = await saga.getPayment(p.id);
    expect(done.state).toBe('EXPIRED');
    expect((await saga.events(p.id)).at(-1)!.data).toMatchObject({ reason: 'payment account sequence left the signing window' });
  });

  it('M3 a balance payment whose payment account was merged before it landed expires as SEQUENCE_GONE', async () => {
    gw.senderSequence = 5000n;
    const q = await getQuote();
    const tx = buildStrictReceive({
      networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: '5000', recipient,
      dest: q.dest, sendMax: q.maxSend, path: q.path, now: Math.floor(t / 1000), mode: 'balance',
    });
    tx.sign(sender);
    const p = await saga.confirm(q.id, { sender: sender.publicKey(), recipient, signedXdr: tx.toXDR(), idemKey: 'k-merge', kind: 'balance' });
    gw.senderSequence = null;
    gw.outcomes.push({ kind: 'bad_seq', codes: { inner_transaction: 'tx_no_account' } }, { kind: 'bad_seq', codes: { inner_transaction: 'tx_no_account' } });
    expect((await saga.reconcile(p.id)).state).toBe('CASH_IN');
    t += 120_000;
    expect((await saga.reconcile(p.id)).state).toBe('EXPIRED');
  });

  it('a stored blob of the old shape (the sender as transaction source) still reconciles and settles', async () => {
    // A Phase 1 blob signed before the fix, already in the ledger: written straight to the store.
    const q = await getQuote();
    const old = buildStrictReceive({
      networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: sender.publicKey(), paymentSequence: '900', recipient,
      dest: q.dest, sendMax: q.maxSend, path: q.path, now: Math.floor(t / 1000),
    });
    old.sign(sender);
    const hash = Array.from(old.hash(), (b) => b.toString(16).padStart(2, '0')).join('');
    const { payment: p } = await store.createPayment({
      id: 'pmt_old', publicId: 'CORRA-OLDOLD', kind: 'cash_in', senderAccount: sender.publicKey(), recipientAccount: recipient,
      corridor: CORRIDOR, quote: q, state: 'SIGNED', legs: [{ kind: 'cash_in', status: 'PENDING', amount: q.maxSend, anchorId: 'corra-anchor' }],
      idemKey: 'k-old', signedXdr: old.toXDR(), innerTxHash: hash, maxTime: Math.floor(t / 1000) + 1800, supersedesId: null, createdAt: t, updatedAt: t,
    }, [{ type: 'SIGNED', from: null, to: 'SIGNED' }]);
    gw.senderSequence = 900n;
    gw.sequenceReads = [];
    expect((await saga.reconcile(p.id)).state).toBe('SIGNED');
    expect(gw.sequenceReads).toEqual([sender.publicKey()]);
    await cashIn(p.id, q.maxSend);
    expect((await saga.reconcile(p.id)).state).toBe('CREDITED');
  });
});
