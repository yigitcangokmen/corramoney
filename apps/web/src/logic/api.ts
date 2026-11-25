import type { DepositWire, FiatCode, MoneyWire, PaymentEvent, PaymentWire, PoolOpWire, QuoteWire } from '@corra/shared';

export const ORCHESTRATOR_URL: string =
  (import.meta as any).env?.VITE_ORCHESTRATOR_URL ?? 'http://localhost:8787';

/** The anchor's SEP-38 quote id and expiry, handed to Corra unchanged. */
export type AnchorQuoteRef = { id: string; expiresAt: number };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retriable = false) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(method: string, path: string, body?: object, headers: Record<string, string> = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${ORCHESTRATOR_URL}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'UNREACHABLE', `Corra orchestrator is not reachable at ${ORCHESTRATOR_URL}`, true);
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = json?.error ?? {};
    throw new ApiError(r.status, e.code ?? 'HTTP_' + r.status, e.message ?? r.statusText, !!e.retriable);
  }
  return json as T;
}

export const api = {
  /** `xdr`: the account's own setup, for the wallet; `paymentAccountXdr`: its payment account, for the throwaway key, submitted first. */
  setup: (account: string, trust: FiatCode[], paymentAccount?: string) =>
    call<{ xdr?: string; paymentAccountXdr?: string }>('POST', '/setup', { account, trust, ...(paymentAccount ? { paymentAccount } : {}) }),

  clientDomainSign: (transaction: string) => call<{ transaction: string }>('POST', '/sep10/client-domain', { transaction }),

  quote: (corridor: { from: string; to: string }, destAmount: MoneyWire) =>
    call<QuoteWire>('POST', '/quote', { corridor, destAmount }),

  confirm: (p: { quoteId: string; sender: string; recipient: string; signedXdr: string; anchorQuote?: AnchorQuoteRef }, idemKey: string) =>
    call<PaymentWire>('POST', '/confirm', p, { 'idempotency-key': idemKey }),

  resign: (p: { supersedesId: string; quoteId: string; signedXdr: string; anchorQuote?: AnchorQuoteRef }, idemKey: string) =>
    call<PaymentWire>('POST', '/resign', p, { 'idempotency-key': idemKey }),

  /** The recipient's signed withdrawal payment for a CREDITED payment; `ref` is the anchor's SEP-24 withdrawal id. */
  cashOutSubmit: (paymentId: string, p: { ref: string; signedXdr: string }) =>
    call<{ txHash: string | null; ledger: number | null; replay: boolean; payment: PaymentWire & { events: PaymentEvent[] } }>(
      'POST', `/payments/${encodeURIComponent(paymentId)}/cash-out/submit`, p),

  linkCashIn: (paymentId: string, ref: string) => call<PaymentWire>('POST', `/payments/${paymentId}/cash-in`, { ref }),

  payment: (id: string) => call<PaymentWire & { events: PaymentEvent[] }>('GET', `/payments/${id}`),

  /** A payment from TESTMXN already in the sender's account: Corra submits the signed blob at once. */
  send: (p: { quoteId: string; sender: string; recipient: string; signedXdr: string }, idemKey: string) =>
    call<PaymentWire>('POST', '/send', p, { 'idempotency-key': idemKey }),

  accountPayments: (account: string, role: 'sender' | 'recipient', limit = 50) =>
    call<{ payments: PaymentWire[] }>('GET', `/accounts/${encodeURIComponent(account)}/payments?role=${role}&limit=${limit}`),

  createDeposit: (account: string, amount: string) => call<DepositWire>('POST', '/deposits', { account, amount }),

  /** Reports the anchor's SEP-24 transaction id. Only the ref: Corra takes the anchor's URL from its signed callback. */
  linkDeposit: (id: string, ref: string) => call<DepositWire>('POST', `/deposits/${encodeURIComponent(id)}/link`, { ref }),

  deposit: (id: string) => call<DepositWire>('GET', `/deposits/${encodeURIComponent(id)}`),

  accountDeposits: (account: string, limit = 50) =>
    call<{ deposits: DepositWire[] }>('GET', `/accounts/${encodeURIComponent(account)}/deposits?limit=${limit}`),

  /** A user-signed Blend submit: Corra validates it, pays the fee (fee-bump) and sends it. */
  poolSubmit: (signedXdr: string, idemKey: string) =>
    call<PoolOpWire>('POST', '/pool/submit', { signedXdr }, { 'idempotency-key': idemKey }),

  accountPoolOps: (account: string, limit = 50) =>
    call<{ ops: PoolOpWire[] }>('GET', `/accounts/${encodeURIComponent(account)}/pool-ops?limit=${limit}`),

  /**
   * Polls a deposit: every 3 s for the first 2 minutes, then every 10 s. Stops on CONFIRMED or
   * EXPIRED, on a 404, or after repeated failures, reporting the last error through `onError`.
   */
  watchDeposit(id: string, onChange: (d: DepositWire) => void, onError?: (e: unknown) => void): () => void {
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    const poll = () => {
      if (stopped) return;
      api.deposit(id).then((d) => {
        if (stopped) return;
        failures = 0;
        onChange(d);
        if (d.status === 'CONFIRMED' || d.status === 'EXPIRED') stop();
      }).catch((e) => {
        if (stopped) return;
        failures++;
        if ((e instanceof ApiError && e.status === 404) || failures >= WATCH_MAX_FAILURES) {
          stop();
          onError?.(e);
        }
      }).finally(() => {
        if (!stopped) timer = setTimeout(poll, Date.now() - started < DEPOSIT_FAST_MS ? 3000 : 10_000);
      });
    };
    poll();
    return stop;
  },

  /**
   * Live saga events. Falls back to polling if EventSource is unavailable or drops. Stops on a
   * terminal state, on a 404 (the payment does not exist here), or after repeated failures,
   * reporting the last error through `onError` instead of polling forever.
   */
  watch(
    id: string,
    onChange: (p: PaymentWire & { events: PaymentEvent[] }) => void,
    onError?: (e: unknown) => void,
  ): () => void {
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let es: EventSource | undefined;
    const stop = () => {
      stopped = true;
      es?.close();
      if (timer) clearTimeout(timer);
    };
    const refresh = () =>
      api.payment(id).then((p) => {
        if (stopped) return;
        failures = 0;
        onChange(p);
        if (TERMINAL.includes(p.state)) stop();
      }).catch((e) => {
        if (stopped) return;
        failures++;
        if ((e instanceof ApiError && e.status === 404) || failures >= WATCH_MAX_FAILURES) {
          stop();
          onError?.(e);
        }
      });
    const poll = () => {
      if (stopped) return;
      refresh().finally(() => {
        if (!stopped) timer = setTimeout(poll, 1500);
      });
    };
    if (typeof EventSource !== 'undefined') {
      es = new EventSource(`${ORCHESTRATOR_URL}/payments/${id}/events`);
      es.addEventListener('state', refresh);
      es.onerror = () => {
        es?.close();
        es = undefined;
        poll();
      };
      refresh();
    } else {
      poll();
    }
    return stop;
  },
};

export const WATCH_MAX_FAILURES = 5;

/** How long a deposit is polled every 3 s before slowing to every 10 s. */
const DEPOSIT_FAST_MS = 2 * 60_000;

export const TERMINAL = ['CREDITED', 'EXPIRED', 'CAP_EXCEEDED', 'FAILED'];
