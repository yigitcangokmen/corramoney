import type { DepositWire, PaymentWire, PoolOpWire } from '@corra/shared';
import { api, ApiError, TERMINAL } from './api';
import { rememberedPayments } from './remit';

export type HistoryRow =
  | { type: 'deposit'; at: number; d: DepositWire }
  | { type: 'sent' | 'received'; at: number; p: PaymentWire }
  | { type: 'pool'; at: number; o: PoolOpWire };

/** Newest first. A payment in both lists (a self-send) appears once, as sent. */
export function mergeHistory(sent: PaymentWire[], received: PaymentWire[], deposits: DepositWire[], poolOps: PoolOpWire[] = []): HistoryRow[] {
  const seen = new Set(sent.map((p) => p.id));
  return [
    ...sent.map((p) => ({ type: 'sent' as const, at: p.createdAt, p })),
    ...received.filter((p) => !seen.has(p.id)).map((p) => ({ type: 'received' as const, at: p.createdAt, p })),
    ...deposits.map((d) => ({ type: 'deposit' as const, at: d.createdAt, d })),
    ...poolOps.map((o) => ({ type: 'pool' as const, at: o.createdAt, o })),
  ].sort((a, b) => b.at - a.at);
}

/** Only http: and https: links are rendered; anything else (javascript:, data:) is dropped. */
export function safeLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const money = (a: string) => Number(a).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The amber note under a deposit row, or '' when there is nothing to explain. */
export function depositNote(d: DepositWire): string {
  const { reason, credited, requested } = d;
  if (reason?.includes('short') && credited) return `credited ${money(credited.amount)} of ${money(requested.amount)} (short credit)`;
  // A short credit stays PENDING, credited set and no reason, until the 24-hour window closes.
  if (d.status === 'PENDING' && credited) return `credited ${money(credited.amount)} of ${money(requested.amount)} so far`;
  if (reason === 'credited after expiry') return 'paid after the 24-hour window';
  if (d.status === 'EXPIRED') return 'no payment within 24 hours';
  return '';
}

/** The cash-out note of a received payment: its leg confirmed by the anchor, a Phase 1 mock payout, or '' (PLAN 3.8). */
export function cashOutNote(p: PaymentWire): string {
  const leg = p.legs.find((l) => l.kind === 'cash_out');
  if (leg?.status !== 'CONFIRMED') return '';
  return leg.externalRef?.startsWith('mock-payout:') ? 'Phase 1 mock payout' : 'Cashed out';
}

/** True while something on the list can still change: a payment settling, a deposit waiting or a pool transaction pending. */
export function needsRefresh(rows: HistoryRow[]): boolean {
  return rows.some((r) => (r.type === 'deposit' ? r.d.status === 'PENDING'
    : r.type === 'pool' ? r.o.status === 'SUBMITTED' : !TERMINAL.includes(r.p.state)));
}

/** The server did not answer (as opposed to answering "no"). */
const lost = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;

/**
 * Sent, received, deposits and pool transactions of the account, from the server. An orchestrator
 * without the account list (404) falls back to the payments remembered in this browser; one
 * without a pool (404, 503) simply has no pool rows.
 */
export async function loadHistory(pk: string): Promise<{ rows: HistoryRow[]; unreachable: number }> {
  const [sent, received, deposits, poolOps] = await Promise.allSettled([
    api.accountPayments(pk, 'sender'),
    api.accountPayments(pk, 'recipient'),
    api.accountDeposits(pk),
    api.accountPoolOps(pk, 20),
  ]);
  let unreachable = 0;
  let sentList: PaymentWire[] = [];
  if (sent.status === 'fulfilled') sentList = sent.value.payments;
  else if (sent.reason instanceof ApiError && sent.reason.status === 404) {
    const ps = await Promise.all(rememberedPayments(pk).map((id) => api.payment(id).catch((e) => {
      if (lost(e)) unreachable++;
      return null;
    })));
    sentList = ps.filter((p): p is NonNullable<typeof p> => !!p);
  } else if (lost(sent.reason)) unreachable++;
  if (received.status === 'rejected' && lost(received.reason)) unreachable++;
  if (deposits.status === 'rejected' && lost(deposits.reason)) unreachable++;
  const noPool = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 503);
  if (poolOps.status === 'rejected' && !noPool(poolOps.reason) && lost(poolOps.reason)) unreachable++;
  return {
    rows: mergeHistory(
      sentList,
      received.status === 'fulfilled' ? received.value.payments : [],
      deposits.status === 'fulfilled' ? deposits.value.deposits : [],
      poolOps.status === 'fulfilled' ? poolOps.value.ops : [],
    ),
    unreachable,
  };
}
