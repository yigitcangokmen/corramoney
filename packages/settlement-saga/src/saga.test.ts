import * as S from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { cashInMemo, fromDecimal, type AssetId, type Corridor, type Money } from '@corra/shared';
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

  async findStrictReceivePath() { return this.route; }
  async findDeposit({ since, memo }: { since: number; memo?: string }) {
    return this.deposits.find((d) => d.at >= since && (memo === undefined || d.memo === memo)) ?? null;
  }
  async accountTrusts() { return this.trusts; }
  /** The sender's current sequence, as Horizon would report it; null = not looked at. */
  senderSequence: bigint | null = null;
  async accountSequence() { return this.senderSequence; }
  /** Fee-bump envelope hash per inner hash, as Horizon reports it for a landed payment. */
  outer = new Map<string, string>();
  async getTransaction(hash: string) {
    const s = this.horizonLagging ? undefined : this.landed.get(hash);
    return s ? { status: s, ledger: 1, codes: this.landedCodes.get(hash), hash: this.outer.get(hash) } : { status: 'NOT_FOUND' as const };
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

beforeEach(() => {
  t = T0;
  ids = 0;
  gw = new FakeGateway();
  store = new InMemorySagaStore(() => t);
  saga = createSaga({
    store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER,
    anchorDistribution: ANCHOR, anchorId: 'corra-anchor', now: () => t,
    newId: (p) => `${p}_${++ids}`,
  });
});

const getQuote = () => saga.quote({ corridor: CORRIDOR, destAmount: fromDecimal(PHP, '1000') });

let seq = 100;
function sign(q: { dest: Money; maxSend: Money; path: AssetId[] }, over: { recipient?: string; sendMax?: Money } = {}) {
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), senderSequence: String(seq++),
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
    expect(ev.at(-1)?.data).toMatchObject({ reason: 'sender sequence left the signing window' });
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

  it('CREDITED needs the payout handler acknowledgement; a failed one is retried from ONCHAIN', async () => {
    let fail = true;
    saga = createSaga({
      store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR, anchorId: 'corra-anchor',
      now: () => t, newId: (p) => `${p}_${++ids}`,
      payout: { acknowledge: async (p) => { if (fail) throw new Error('payout down'); return { ref: `po-${p.id}` }; } },
    });
    const { q, p } = await confirmed();
    await cashIn(p.id, q.maxSend);
    await expect(saga.reconcile(p.id)).rejects.toThrow('payout down');
    expect((await store.getPayment(p.id))!.state).toBe('ONCHAIN');
    fail = false;
    const done = await saga.reconcile(p.id);
    expect(done.state).toBe('CREDITED');
    expect(done.legs.find((l) => l.kind === 'cash_out')).toMatchObject({ status: 'CONFIRMED', externalRef: `po-${p.id}` });
    expect((await store.events(p.id)).at(-1)?.data).toMatchObject({ payoutRef: `po-${p.id}` });
    expect(gw.submits).toBe(1); // the retry settled from chain state, it did not resubmit
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
