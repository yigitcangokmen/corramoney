import type { Leg, LegKind, Payment, PaymentEvent, PaymentState, Quote } from '@corra/shared';
import { alreadySuperseded, cashInAlreadyLinked, duplicateTransaction, publicIdTaken, quoteUsed } from './errors';
import { PENDING_STATES } from './transitions';

export type LegUpdate = Partial<Leg> & { kind: LegKind };

export type NewEvent = { type: string; from: PaymentState | null; to: PaymentState | null; data?: Record<string, unknown> };

/**
 * Persistence the saga needs. Every state change goes through `transition`, which must be
 * atomic: apply only if the payment is still in `from`, upsert legs, append the next event.
 */
export interface SagaStore {
  saveQuote(q: Quote): Promise<void>;
  getQuote(id: string): Promise<Quote | null>;
  /**
   * Idempotent on payment.idemKey. Throws quoteUsed if the quote already belongs to another
   * payment, duplicateTransaction if the signed transaction already backs one, publicIdTaken on
   * a public id collision.
   */
  createPayment(p: Payment, events: NewEvent[]): Promise<{ payment: Payment; created: boolean }>;
  /** By internal id, or by the public id (CORRA-XXXXXX). */
  getPayment(id: string): Promise<Payment | null>;
  getPaymentByIdemKey(idemKey: string): Promise<Payment | null>;
  /** Payments of one sender in any of `states`, oldest first. */
  listBySender(sender: string, states: PaymentState[]): Promise<Payment[]>;
  findPaymentByCashInRef(anchorId: string, ref: string): Promise<Payment | null>;
  /** Links the anchor's SEP-24 transaction id to the cash-in leg. Unique per (anchorId, ref): a ref already used by another payment throws cashInAlreadyLinked. */
  linkCashIn(paymentId: string, anchorId: string, ref: string): Promise<void>;
  /** Returns the updated payment, or null when the payment is no longer in `from` (no-op). */
  transition(
    id: string,
    from: PaymentState,
    to: PaymentState,
    patch: { signedXdr?: string | null; legs?: LegUpdate[] },
    event: NewEvent,
  ): Promise<Payment | null>;
  /** Pending payments not updated for at least `idleMs`. */
  listPending(idleMs: number, now: number): Promise<Payment[]>;
  events(id: string): Promise<PaymentEvent[]>;
}

const applyLegs = (legs: Leg[], updates: LegUpdate[] = []): Leg[] => {
  const out = legs.map((l) => ({ ...l }));
  for (const u of updates) {
    const i = out.findIndex((l) => l.kind === u.kind);
    if (i >= 0) out[i] = { ...out[i], ...u };
    else out.push(u as Leg);
  }
  return out;
};

export class InMemorySagaStore implements SagaStore {
  private quotes = new Map<string, Quote>();
  private quoteOwner = new Map<string, string>();
  private payments = new Map<string, Payment>();
  private byIdem = new Map<string, string>();
  private cashInRefs = new Map<string, string>();
  private log = new Map<string, PaymentEvent[]>();

  constructor(private now: () => number = Date.now) {}

  async saveQuote(q: Quote) {
    this.quotes.set(q.id, structuredClone(q));
  }

  async getQuote(id: string) {
    const q = this.quotes.get(id);
    return q ? structuredClone(q) : null;
  }

  async createPayment(p: Payment, events: NewEvent[]) {
    const existing = this.byIdem.get(p.idemKey);
    if (existing) return { payment: structuredClone(this.payments.get(existing)!), created: false };
    const owner = this.quoteOwner.get(p.quote.id);
    if (owner && owner !== p.id) throw quoteUsed();
    const all = [...this.payments.values()];
    if (all.some((o) => o.innerTxHash === p.innerTxHash)) throw duplicateTransaction();
    if (p.supersedesId && all.some((o) => o.supersedesId === p.supersedesId)) throw alreadySuperseded();
    if (all.some((o) => o.publicId === p.publicId)) throw publicIdTaken();
    this.quoteOwner.set(p.quote.id, p.id);
    this.byIdem.set(p.idemKey, p.id);
    this.payments.set(p.id, structuredClone(p));
    this.log.set(p.id, events.map((e, i) => ({ ...e, seq: i + 1, at: this.now() })));
    return { payment: structuredClone(p), created: true };
  }

  /** By internal id, or by the public id people see (CORRA-XXXXXX). */
  async getPayment(id: string) {
    const p = this.payments.get(id) ?? [...this.payments.values()].find((x) => x.publicId === id);
    return p ? structuredClone(p) : null;
  }

  async getPaymentByIdemKey(idemKey: string) {
    const id = this.byIdem.get(idemKey);
    return id ? this.getPayment(id) : null;
  }

  async listBySender(sender: string, states: PaymentState[]) {
    return [...this.payments.values()]
      .filter((p) => p.senderAccount === sender && states.includes(p.state))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => structuredClone(p));
  }

  async findPaymentByCashInRef(anchorId: string, ref: string) {
    const id = this.cashInRefs.get(`${anchorId}|${ref}`);
    return id ? this.getPayment(id) : null;
  }

  async linkCashIn(paymentId: string, anchorId: string, ref: string) {
    const key = `${anchorId}|${ref}`;
    const owner = this.cashInRefs.get(key);
    if (owner && owner !== paymentId) throw cashInAlreadyLinked();
    const p = this.payments.get(paymentId);
    if (!p) return;
    this.cashInRefs.set(key, paymentId);
    p.legs = applyLegs(p.legs, [{ kind: 'cash_in', anchorId, externalRef: ref }]);
    p.updatedAt = this.now();
  }

  async transition(
    id: string,
    from: PaymentState,
    to: PaymentState,
    patch: { signedXdr?: string | null; legs?: LegUpdate[] },
    event: NewEvent,
  ) {
    const p = this.payments.get(id);
    if (!p || p.state !== from) return null;
    p.state = to;
    if (patch.signedXdr !== undefined) p.signedXdr = patch.signedXdr;
    p.legs = applyLegs(p.legs, patch.legs);
    p.updatedAt = this.now();
    const log = this.log.get(id)!;
    log.push({ ...event, seq: log.length + 1, at: this.now() });
    return structuredClone(p);
  }

  async listPending(idleMs: number, now: number) {
    return [...this.payments.values()]
      .filter((p) => PENDING_STATES.includes(p.state) && now - p.updatedAt >= idleMs)
      .map((p) => structuredClone(p));
  }

  async events(id: string) {
    return structuredClone(this.log.get(id) ?? []);
  }
}
