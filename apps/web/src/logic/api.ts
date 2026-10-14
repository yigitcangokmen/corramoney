import type { FiatCode, MoneyWire, PaymentEvent, PaymentWire, QuoteWire } from '@corra/shared';

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
  setup: (account: string, trust: FiatCode[]) => call<{ xdr: string }>('POST', '/setup', { account, trust }),

  clientDomainSign: (transaction: string) => call<{ transaction: string }>('POST', '/sep10/client-domain', { transaction }),

  quote: (corridor: { from: string; to: string }, destAmount: MoneyWire) =>
    call<QuoteWire>('POST', '/quote', { corridor, destAmount }),

  confirm: (p: { quoteId: string; sender: string; recipient: string; signedXdr: string; anchorQuote?: AnchorQuoteRef }, idemKey: string) =>
    call<PaymentWire>('POST', '/confirm', p, { 'idempotency-key': idemKey }),

  resign: (p: { supersedesId: string; quoteId: string; signedXdr: string; anchorQuote?: AnchorQuoteRef }, idemKey: string) =>
    call<PaymentWire>('POST', '/resign', p, { 'idempotency-key': idemKey }),

  linkCashIn: (paymentId: string, ref: string) => call<PaymentWire>('POST', `/payments/${paymentId}/cash-in`, { ref }),

  payment: (id: string) => call<PaymentWire & { events: PaymentEvent[] }>('GET', `/payments/${id}`),

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

export const TERMINAL = ['CREDITED', 'EXPIRED', 'CAP_EXCEEDED', 'FAILED'];
