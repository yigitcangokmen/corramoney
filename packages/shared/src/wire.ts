/** JSON shapes for the API and the ledger's JSONB columns. Money travels as decimal strings, never floats. */
import type { AssetId } from './assets';
import { fromDecimal, toDecimal, type Money } from './money';
import type { Corridor } from './corridors';
import type { Leg, Payment, PaymentEvent, Quote } from './types';

export type MoneyWire = { amount: string; asset: string; issuer?: string };
export type AssetWire = { code: string; issuer?: string };

export const moneyToWire = (m: Money): MoneyWire => ({
  amount: toDecimal(m),
  asset: m.asset.code,
  ...(m.asset.issuer ? { issuer: m.asset.issuer } : {}),
});

export const moneyFromWire = (w: MoneyWire): Money =>
  fromDecimal({ code: w.asset, ...(w.issuer ? { issuer: w.issuer } : {}) }, w.amount);

/** "MX/MXN" <-> { country: 'MX', currency: 'MXN' } */
export const corridorToWire = (c: Corridor) => ({
  from: `${c.from.country}/${c.from.currency}`,
  to: `${c.to.country}/${c.to.currency}`,
});

export const corridorFromWire = (w: { from: string; to: string }): Corridor => {
  const side = (s: string) => {
    const [country, currency] = String(s).split('/');
    if (!country || !currency) throw new Error(`invalid corridor side: ${s}`);
    return { country, currency };
  };
  return { from: side(w.from), to: side(w.to) };
};

export type QuoteWire = Omit<Quote, 'source' | 'dest' | 'maxSend' | 'corridor' | 'path'> & {
  corridor: { from: string; to: string };
  source: MoneyWire;
  dest: MoneyWire;
  maxSend: MoneyWire;
  path: AssetWire[];
};

export const quoteToWire = (q: Quote): QuoteWire => ({
  ...q,
  corridor: corridorToWire(q.corridor),
  source: moneyToWire(q.source),
  dest: moneyToWire(q.dest),
  maxSend: moneyToWire(q.maxSend),
  path: q.path.map((a: AssetId) => ({ ...a })),
});

export const quoteFromWire = (w: QuoteWire): Quote => ({
  ...w,
  corridor: corridorFromWire(w.corridor),
  source: moneyFromWire(w.source),
  dest: moneyFromWire(w.dest),
  maxSend: moneyFromWire(w.maxSend),
  path: w.path.map((a) => ({ ...a })),
});

export type LegWire = Omit<Leg, 'amount'> & { amount: MoneyWire };

export type PaymentWire = Omit<Payment, 'quote' | 'legs' | 'corridor' | 'signedXdr' | 'idemKey'> & {
  corridor: { from: string; to: string };
  quote: QuoteWire;
  legs: LegWire[];
  events?: PaymentEvent[];
};

/** API view of a payment. The signed blob and idempotency key never leave the server. */
export const paymentToWire = (p: Payment, events?: PaymentEvent[]): PaymentWire => {
  const { signedXdr: _x, idemKey: _k, quote, legs, corridor, ...rest } = p;
  return {
    ...rest,
    corridor: corridorToWire(corridor),
    quote: quoteToWire(quote),
    legs: legs.map((l) => ({ ...l, amount: moneyToWire(l.amount) })),
    ...(events ? { events } : {}),
  };
};
