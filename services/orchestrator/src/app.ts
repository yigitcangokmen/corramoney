import Fastify, { type FastifyReply } from 'fastify';
import * as S from '@stellar/stellar-sdk';
import cors from '@fastify/cors';
import {
  FIAT,
  corridorFromWire,
  depositToWire,
  fiatAsset,
  fromDecimal,
  moneyFromWire,
  parseUnits,
  paymentToWire,
  poolOpToWire,
  quoteToWire,
  type FiatCode,
  type MoneyWire,
} from '@corra/shared';
import { SagaError, withTimeout, type CashOuts, type Deposits, type Saga } from '@corra/settlement-saga';
import { ChannelRefusal, PoolRefusal, SponsorRefusal } from '@corra/stellar';
import { parseSep24Callback, verifyCallbackSignature } from './callback';
import { ChallengeRefusal } from './client-domain';
import type { PoolOps } from './pool-ops';
import { createLimiter } from './rate-limit';
import type { SetupXdrs } from './setup';

export type AppDeps = {
  saga: Saga;
  deposits: Deposits;
  /** The recipient's SEP-24 withdrawal of a CREDITED payment (D3). */
  cashOuts: CashOuts;
  networkPassphrase: string;
  corsOrigins: string[];
  clientDomain: { publicKey: string; coSignChallenge(xdr: string, anchorSigningKey: string): string };
  /**
   * Builds and signs the CAP-33 setup transactions the account still needs; null when it needs none.
   * `admit` takes the account's rate-limit token before anything is leased or signed.
   */
  prepareSetup(account: string, trust: FiatCode[], paymentAccount?: string, admit?: () => boolean): Promise<SetupXdrs | null>;
  anchorSigningKey(): Promise<string>;
  /** Absent when no pool is deployed: the pool routes answer 503. */
  poolOps?: PoolOps;
  now?: () => number;
  log?: boolean;
  /** Per-route budgets; tests may loosen them. */
  limits?: Partial<typeof DEFAULT_LIMITS>;
  /** How long a terminal withdrawal callback may take before the 503; tests shorten it. */
  callbackWorkMs?: number;
};

/**
 * The sponsor pays real reserves for every setup, so /setup is the expensive route: a few per IP,
 * one per account, and a global hourly ceiling that bounds what any caller can make it lock up.
 */
export const DEFAULT_LIMITS = {
  setupPerIp: { max: 5, windowMs: 10 * 60_000 },
  setupPerAccount: { max: 1, windowMs: 10 * 60_000 },
  setupGlobal: { max: 60, windowMs: 60 * 60_000 },
  quotePerIp: { max: 60, windowMs: 60_000 },
  clientDomainPerIp: { max: 30, windowMs: 60_000 },
  depositPerIp: { max: 10, windowMs: 10 * 60_000 },
  depositPerAccount: { max: 3, windowMs: 10 * 60_000 },
  /** Each link walks Horizon once. */
  depositLinkPerIp: { max: 30, windowMs: 10 * 60_000 },
  sendPerIp: { max: 20, windowMs: 10 * 60_000 },
  sendPerAccount: { max: 10, windowMs: 10 * 60_000 },
  /** The /accounts/:account/* lists. */
  readPerIp: { max: 60, windowMs: 60_000 },
  /** The sponsor pays every pool transaction's fees (up to 0.5 XLM each): 300 a day bounds that. */
  poolPerIp: { max: 30, windowMs: 10 * 60_000 },
  poolPerAccount: { max: 10, windowMs: 10 * 60_000 },
  poolGlobal: { max: 300, windowMs: 24 * 3_600_000 },
  /** New withdrawal payments the sponsor fee-bumps; taken only for a blob proven to be the recipient's. */
  cashOutPerIp: { max: 5, windowMs: 10 * 60_000 },
};

/** The local stack only (CORRA_LOCAL_SETUP_LIMITS=1): scripts share one IP. setupPerAccount is unchanged. */
export const LOCAL_SETUP_LIMITS = {
  setupPerIp: { max: 200, windowMs: 10 * 60_000 },
  setupGlobal: { max: 2000, windowMs: 60 * 60_000 },
} satisfies Partial<typeof DEFAULT_LIMITS>;

const SSE_MAX_MS = 35 * 60_000;
/** A withdrawal's completed or stopped callback is recorded within this, else 503 (a few Horizon reads and two writes). */
const CALLBACK_WORK_MS = 10_000;

const fail = (reply: FastifyReply, status: number, code: string, message: string, retriable = false) =>
  reply.code(status).send({ error: { code, message, retriable } });

const G = /^G[A-Z2-7]{55}$/;
/** A deposit amount in MXN: whole pesos and up to 2 decimals. */
const MXN_AMOUNT = /^\d{1,7}(\.\d{1,2})?$/;
/** A signed pool transaction: one Soroban call with its auth and footprint is a few KB. */
const MAX_POOL_XDR = 16_384;
/** A signed withdrawal payment: one classic operation and one signature. */
const MAX_CASH_OUT_XDR = 4096;
/** An anchor's transaction reference. */
const REF = /^[A-Za-z0-9._:-]{1,128}$/;
const MIN_DEPOSIT = parseUnits('1');
const MAX_DEPOSIT = parseUnits('1000000');

/** `?limit=` of the list routes: absent -> 50, an integer 1..100, anything else null (400). */
function limitOf(v: unknown): number | null {
  if (v === undefined) return 50;
  if (typeof v !== 'string' || !/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 100 ? n : null;
}

/** Optional SEP-38 firm quote reference from the client: shape-checked, then stored unchanged. */
function anchorQuoteOf(v: unknown): { id: string; expiresAt: number } | undefined | 'invalid' {
  if (v === undefined || v === null) return undefined;
  const q = v as { id?: unknown; expiresAt?: unknown };
  if (typeof q.id !== 'string' || !q.id || q.id.length > 128) return 'invalid';
  if (typeof q.expiresAt !== 'number' || !Number.isFinite(q.expiresAt)) return 'invalid';
  return { id: q.id, expiresAt: q.expiresAt };
}

export function buildApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  // The anchor's HTTP client (OkHttp) keeps idle connections for 5 minutes and reuses them. With
  // Fastify's default 72s keep-alive, a stellar.toml fetch or callback after a quiet minute hit a
  // socket we had already closed ("unexpected end of stream"). Outlive the client's pool instead.
  // Caddy is the only ingress, so the client address comes from its X-Forwarded-For.
  const app = Fastify({ logger: deps.log ?? false, keepAliveTimeout: 310_000, trustProxy: true, bodyLimit: 64 * 1024 });

  app.register(cors, { origin: deps.corsOrigins });

  const L = { ...DEFAULT_LIMITS, ...deps.limits };
  const lim = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, createLimiter(v.max, v.windowMs, now)])) as
    Record<keyof typeof DEFAULT_LIMITS, ReturnType<typeof createLimiter>>;
  const limited = (reply: FastifyReply) => fail(reply, 429, 'RATE_LIMITED', 'too many requests, try again later', true);

  /** Work a route starts without awaiting; app.close() waits for it (15 s at most), so shutdown and tests never cut it off mid-write. */
  const background = new Set<Promise<unknown>>();
  const inBackground = (p: Promise<unknown>) => {
    const q: Promise<unknown> = p.catch((e) => app.log.error(e)).finally(() => background.delete(q));
    background.add(q);
  };
  /**
   * An open event stream is an in-flight request, and app.close() waits for those: without this the
   * shutdown drain would block until SIGKILL while a browser watches a payment (C3-1). preClose ends
   * every stream at once; the EventSource reconnects to the next instance.
   */
  let closing = false;
  const wakeStreams = new Set<() => void>();
  app.addHook('preClose', async () => {
    closing = true;
    for (const wake of [...wakeStreams]) wake();
  });
  app.addHook('onClose', async () => {
    const until = Date.now() + 15_000;
    while (background.size && Date.now() < until) {
      await withTimeout(Promise.allSettled([...background]), until - Date.now()).catch(() => {});
    }
    if (background.size) app.log.error({ evt: 'app.close_drain_timeout', pending: background.size });
  });

  // Keep the raw callback body: the anchor's signature covers the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(Object.assign(new Error('malformed JSON body'), { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SagaError) return fail(reply, err.status, err.code, err.message, err.retriable);
    if (err instanceof SponsorRefusal || err instanceof ChannelRefusal || err instanceof PoolRefusal || err instanceof ChallengeRefusal) {
      return fail(reply, 422, 'REFUSED', err.message);
    }
    const status = (err as { statusCode?: number }).statusCode;
    if ((err as any).validation || status === 400) return fail(reply, 400, 'BAD_REQUEST', (err as Error).message);
    if (status === 413) return fail(reply, 413, 'TOO_LARGE', 'request body too large');
    app.log.error(err);
    return fail(reply, 500, 'INTERNAL', 'internal error', true);
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/.well-known/stellar.toml', async (_req, reply) =>
    reply
      .type('text/plain')
      .header('access-control-allow-origin', '*')
      .send(`NETWORK_PASSPHRASE="${deps.networkPassphrase}"\nSIGNING_KEY="${deps.clientDomain.publicKey}"\n`),
  );

  app.post<{ Body: { corridor: { from: string; to: string }; destAmount: MoneyWire } }>('/quote', async (req, reply) => {
    if (!lim.quotePerIp.take(req.ip)) return limited(reply);
    const { corridor, destAmount } = req.body ?? ({} as any);
    if (!corridor || !destAmount) return fail(reply, 400, 'BAD_REQUEST', 'corridor and destAmount are required');
    let c, dest;
    try {
      c = corridorFromWire(corridor);
      dest = moneyFromWire(destAmount);
    } catch (e) {
      return fail(reply, 400, 'BAD_REQUEST', (e as Error).message);
    }
    if (dest.raw <= 0n) return fail(reply, 400, 'BAD_REQUEST', 'destAmount must be positive');
    return quoteToWire(await deps.saga.quote({ corridor: c, destAmount: dest }));
  });

  app.post<{ Body: { quoteId: string; sender: string; recipient: string; signedXdr: string; anchorQuote?: unknown } }>('/confirm', async (req, reply) => {
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || !idemKey) return fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    const { quoteId, sender, recipient, signedXdr } = req.body ?? ({} as any);
    if (!quoteId || !G.test(sender ?? '') || !G.test(recipient ?? '') || !signedXdr) {
      return fail(reply, 400, 'BAD_REQUEST', 'quoteId, sender, recipient and signedXdr are required');
    }
    const anchorQuote = anchorQuoteOf(req.body?.anchorQuote);
    if (anchorQuote === 'invalid') return fail(reply, 400, 'BAD_REQUEST', 'anchorQuote must be { id: string, expiresAt: number }');
    const prior = await deps.saga.findByIdemKey(idemKey);
    if (prior?.kind === 'balance') throw new SagaError('IDEMPOTENCY_KEY_REUSED', 409, 'this Idempotency-Key was already used for a different request');
    if (prior) return reply.code(200).send(paymentToWire(prior));
    const p = await deps.saga.confirm(quoteId, { sender, recipient, signedXdr, idemKey, anchorQuote });
    return reply.code(201).send(paymentToWire(p));
  });

  app.post<{ Body: { supersedesId: string; quoteId: string; signedXdr: string; anchorQuote?: unknown } }>('/resign', async (req, reply) => {
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || !idemKey) return fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    const { supersedesId, quoteId, signedXdr } = req.body ?? ({} as any);
    if (!supersedesId || !quoteId || !signedXdr) return fail(reply, 400, 'BAD_REQUEST', 'supersedesId, quoteId and signedXdr are required');
    const anchorQuote = anchorQuoteOf(req.body?.anchorQuote);
    if (anchorQuote === 'invalid') return fail(reply, 400, 'BAD_REQUEST', 'anchorQuote must be { id: string, expiresAt: number }');
    // A re-signed balance payment is a balance send: the /send limits, and submitted at once.
    const prior = await deps.saga.findByIdemKey(idemKey);
    const old = prior ? null : await deps.saga.getPayment(supersedesId);
    if (old?.kind === 'balance' && !lim.sendPerIp.take(req.ip)) return limited(reply);
    const admit = old?.kind === 'balance' ? () => lim.sendPerAccount.take(old.senderAccount) : undefined;
    const p = await deps.saga.resign(supersedesId, quoteId, signedXdr, idemKey, anchorQuote, admit);
    if (!prior && p.kind === 'balance') inBackground(deps.saga.reconcile(p.id));
    return reply.code(201).send(paymentToWire(p));
  });

  app.get<{ Params: { id: string } }>('/payments/:id', async (req) => {
    const p = await deps.saga.getPayment(req.params.id);
    return paymentToWire(p, await deps.saga.events(p.id));
  });

  /** The browser reports the anchor's SEP-24 transaction id so the callback can be matched. */
  app.post<{ Params: { id: string }; Body: { ref: string } }>('/payments/:id/cash-in', async (req, reply) => {
    if (!req.body?.ref) return fail(reply, 400, 'BAD_REQUEST', 'ref is required');
    await deps.saga.linkCashIn(req.params.id, String(req.body.ref));
    const p = await deps.saga.reconcile(req.params.id);
    return paymentToWire(p, await deps.saga.events(p.id));
  });

  /**
   * The recipient's signed withdrawal payment for a CREDITED payment. The recipient's signature on
   * the blob is what binds `ref` (the anchor's SEP-24 withdrawal id) to the payment's cash-out leg.
   */
  app.post<{ Params: { id: string }; Body: { ref: unknown; signedXdr: unknown } }>('/payments/:id/cash-out/submit', async (req, reply) => {
    const { ref, signedXdr } = req.body ?? ({} as any);
    if (typeof ref !== 'string' || !REF.test(ref)) return fail(reply, 400, 'BAD_REQUEST', 'ref is required ([A-Za-z0-9._:-], up to 128)');
    if (typeof signedXdr !== 'string' || !signedXdr || signedXdr.length > MAX_CASH_OUT_XDR) {
      return fail(reply, 400, 'BAD_REQUEST', `signedXdr is required (a string of up to ${MAX_CASH_OUT_XDR} characters)`);
    }
    const r = await deps.cashOuts.submit({ paymentId: req.params.id, ref, signedXdr, admit: () => lim.cashOutPerIp.take(req.ip) });
    return { txHash: r.txHash, ledger: r.ledger, replay: r.replay, payment: paymentToWire(r.payment, r.events) };
  });

  app.get<{ Params: { id: string } }>('/payments/:id/events', async (req, reply) => {
    const p = await deps.saga.getPayment(req.params.id);
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // The same allowlist as every other route: raw responses bypass the CORS plugin.
      ...(origin && deps.corsOrigins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    });
    let sent = 0;
    let closed = false;
    req.raw.on('close', () => (closed = true));
    // A payment is terminal well within its 30-minute window plus grace; the client reconnects or polls after.
    const until = now() + SSE_MAX_MS;
    while (!closed && !closing && now() < until) {
      const events = await deps.saga.events(p.id);
      for (const e of events.slice(sent)) reply.raw.write(`event: state\ndata: ${JSON.stringify(e)}\n\n`);
      sent = events.length;
      const last = events.at(-1);
      if (last?.to && deps.saga.isTerminal(last.to)) break;
      await new Promise<void>((r) => {
        const t = setTimeout(done, 1000);
        function done() { clearTimeout(t); wakeStreams.delete(done); r(); }
        wakeStreams.add(done);
      });
    }
    reply.raw.end();
    return reply;
  });

  app.post('/callbacks/sep24', async (req, reply) => {
    const check = verifyCallbackSignature({
      header: req.headers['signature'] as string | undefined,
      host: String(req.headers.host ?? ''),
      body: (req as any).rawBody ?? '',
      anchorSigningKey: await deps.anchorSigningKey(),
      nowSec: Math.floor(now() / 1000),
    });
    if (!check.ok) return fail(reply, 401, 'BAD_SIGNATURE', check.reason);
    const ev = parseSep24Callback(req.body, now());
    // A withdrawal belongs to a payment's cash-out leg only. Its `completed` or stop is the only
    // record of the anchor's word (nothing asks the anchor later), so it is written before the 200,
    // and a failure answers 503 for the anchor to resend. Other callbacks are only a trigger: a fast 200.
    if (ev?.kind === 'withdrawal' && (ev.status === 'CONFIRMED' || ev.status === 'FAILED')) {
      // Tracked as background work too: after a 503 timeout the write still runs, and app.close() waits for it.
      const work = deps.cashOuts.onCallback(ev);
      inBackground(work);
      try {
        await withTimeout(work, deps.callbackWorkMs ?? CALLBACK_WORK_MS);
      } catch (e) {
        app.log.error(e);
        return fail(reply, 503, 'CALLBACK_NOT_RECORDED', 'the callback was not recorded; send it again', true);
      }
    } else if (ev?.kind === 'withdrawal') {
      inBackground(deps.cashOuts.onCallback(ev));
    } else if (ev) {
      // Payments and deposits both get it: a payment's cash-in leg holding a ref must not hide a
      // deposit's callback (refs are readable and a payment's cash-in link is open to anyone).
      inBackground(Promise.allSettled([deps.saga.onCashIn(ev), deps.deposits.onCallback(ev)]).then((rs) => {
        for (const r of rs) if (r.status === 'rejected') app.log.error(r.reason);
      }));
    }
    return { ok: true };
  });

  app.post<{ Body: { quoteId: string; sender: string; recipient: string; signedXdr: string } }>('/send', async (req, reply) => {
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || !idemKey) return fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    const { quoteId, sender, recipient, signedXdr } = req.body ?? ({} as any);
    if (!quoteId || typeof sender !== 'string' || !G.test(sender) || typeof recipient !== 'string' || !G.test(recipient) || !signedXdr) {
      return fail(reply, 400, 'BAD_REQUEST', 'quoteId, sender, recipient and signedXdr are required');
    }
    // A client retry is never rate limited; confirm() checks that it is the same request. The
    // per-account token is taken inside the saga, only once the blob is proven to be the sender's:
    // `sender` here is just a body field, and junk naming someone must not lock them out.
    const prior = await deps.saga.findByIdemKey(idemKey);
    if (!prior && !lim.sendPerIp.take(req.ip)) return limited(reply);
    const admit = () => lim.sendPerAccount.take(sender);
    const p = await deps.saga.confirm(quoteId, { sender, recipient, signedXdr, idemKey, kind: 'balance', admit });
    if (prior) return reply.code(200).send(paymentToWire(p));
    // Submit now instead of waiting for the reconciler; the response does not wait for the chain.
    inBackground(deps.saga.reconcile(p.id));
    return reply.code(201).send(paymentToWire(p));
  });

  app.get<{ Params: { account: string }; Querystring: { role?: string; limit?: string } }>('/accounts/:account/payments', async (req, reply) => {
    const { account } = req.params;
    const role = req.query.role ?? 'sender';
    const limit = limitOf(req.query.limit);
    if (!G.test(account) || (role !== 'sender' && role !== 'recipient') || limit === null) {
      return fail(reply, 400, 'BAD_REQUEST', 'a G... account, role sender or recipient, and limit 1..100 are required');
    }
    if (!lim.readPerIp.take(req.ip)) return limited(reply);
    return { payments: (await deps.saga.listPayments(account, role, limit)).map((p) => paymentToWire(p)) };
  });

  app.post<{ Body: { account: string; amount: unknown } }>('/deposits', async (req, reply) => {
    const { account, amount } = req.body ?? ({} as any);
    if (typeof account !== 'string' || !G.test(account) || typeof amount !== 'string' || !MXN_AMOUNT.test(amount)) {
      return fail(reply, 400, 'BAD_REQUEST', 'account and amount (a decimal string, up to 2 decimals) are required');
    }
    const raw = parseUnits(amount);
    if (raw < MIN_DEPOSIT || raw > MAX_DEPOSIT) return fail(reply, 400, 'BAD_REQUEST', 'amount must be between 1.00 and 1,000,000.00');
    if (!lim.depositPerIp.take(req.ip) || !lim.depositPerAccount.take(account)) return limited(reply);
    return reply.code(201).send(depositToWire(await deps.deposits.create(account, fromDecimal(fiatAsset('MXN'), amount))));
  });

  /** The browser reports the anchor's SEP-24 transaction id. Any URL in the body is ignored: only the anchor's signed callback sets one. */
  app.post<{ Params: { id: string }; Body: { ref: unknown } }>('/deposits/:id/link', async (req, reply) => {
    const ref = req.body?.ref;
    if (typeof ref !== 'string' || !REF.test(ref)) return fail(reply, 400, 'BAD_REQUEST', 'ref is required ([A-Za-z0-9._:-], up to 128)');
    if (!lim.depositLinkPerIp.take(req.ip)) return limited(reply);
    return depositToWire(await deps.deposits.link(req.params.id, ref));
  });

  app.get<{ Params: { id: string } }>('/deposits/:id', async (req) => depositToWire(await deps.deposits.get(req.params.id)));

  app.get<{ Params: { account: string }; Querystring: { limit?: string } }>('/accounts/:account/deposits', async (req, reply) => {
    const limit = limitOf(req.query.limit);
    if (!G.test(req.params.account) || limit === null) {
      return fail(reply, 400, 'BAD_REQUEST', 'a G... account and limit 1..100 are required');
    }
    if (!lim.readPerIp.take(req.ip)) return limited(reply);
    return { deposits: (await deps.deposits.listByAccount(req.params.account, limit)).map(depositToWire) };
  });

  const poolMissing = (reply: FastifyReply) => fail(reply, 503, 'POOL_NOT_CONFIGURED', 'no lending pool is deployed on this network', true);

  /** A user-signed Blend submit Corra validates, fee-bumps and sends. The position itself is read from the pool contract. */
  app.post<{ Body: { signedXdr: unknown } }>('/pool/submit', async (req, reply) => {
    const pool = deps.poolOps;
    if (!pool) return poolMissing(reply);
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || !idemKey || idemKey.length > 128) {
      return fail(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required (up to 128 characters)');
    }
    const signedXdr = req.body?.signedXdr;
    if (typeof signedXdr !== 'string' || !signedXdr || signedXdr.length > MAX_POOL_XDR) {
      return fail(reply, 400, 'BAD_REQUEST', `signedXdr is required (a string of up to ${MAX_POOL_XDR} characters)`);
    }
    // A retry is never rate limited; the account's token is taken only once the blob is proven to be its own.
    const prior = await pool.findByIdemKey(idemKey);
    if (!prior && !lim.poolPerIp.take(req.ip)) return limited(reply);
    const { op, replay } = await pool.submit({
      signedXdr, idemKey, admit: (a) => lim.poolPerAccount.take(a) && lim.poolGlobal.take('all'),
    });
    return reply.code(replay ? 200 : 201).send(poolOpToWire(op));
  });

  app.get<{ Params: { account: string }; Querystring: { limit?: string } }>('/accounts/:account/pool-ops', async (req, reply) => {
    const pool = deps.poolOps;
    if (!pool) return poolMissing(reply);
    const limit = limitOf(req.query.limit);
    if (!G.test(req.params.account) || limit === null) {
      return fail(reply, 400, 'BAD_REQUEST', 'a G... account and limit 1..100 are required');
    }
    if (!lim.readPerIp.take(req.ip)) return limited(reply);
    return { ops: (await pool.list(req.params.account, limit)).map(poolOpToWire) };
  });

  app.post<{ Body: { account: string; trust?: unknown; paymentAccount?: unknown } }>('/setup', async (req, reply) => {
    const account = req.body?.account;
    if (!G.test(account ?? '') || !S.StrKey.isValidEd25519PublicKey(account)) return fail(reply, 400, 'BAD_REQUEST', 'account is required');
    const paymentAccount = req.body.paymentAccount;
    if (paymentAccount !== undefined && (typeof paymentAccount !== 'string' || !S.StrKey.isValidEd25519PublicKey(paymentAccount) || paymentAccount === account)) {
      return fail(reply, 400, 'BAD_REQUEST', 'paymentAccount must be a G... key other than the account');
    }
    const trust = req.body.trust ?? ['MXN'];
    if (!Array.isArray(trust) || trust.length < 1 || trust.length > 2 || new Set(trust).size !== trust.length ||
        !trust.every((c) => typeof c === 'string' && Object.hasOwn(FIAT, c))) {
      return fail(reply, 400, 'BAD_REQUEST', `trust must be one or two distinct codes of ${Object.keys(FIAT).join(', ')}`);
    }
    if (!lim.setupPerIp.take(req.ip) || !lim.setupGlobal.take('all')) return limited(reply);
    // Only the account's own sandwich spends its token. A 409, or a payment-account-only setup that
    // anyone can ask for on someone else's account, must not lock that account out for the window:
    // those stay bounded by the per-IP and global limits, and once a payment account exists there is
    // nothing more to build for it.
    const out = await deps.prepareSetup(account, trust as FiatCode[], paymentAccount, () => lim.setupPerAccount.take(account));
    if (!out) return fail(reply, 409, 'NOTHING_TO_SET_UP', 'the account, its trustlines and its payment account are already set up');
    return out;
  });

  app.post<{ Body: { transaction: string } }>('/sep10/client-domain', async (req, reply) => {
    if (!lim.clientDomainPerIp.take(req.ip)) return limited(reply);
    if (typeof req.body?.transaction !== 'string') return fail(reply, 400, 'BAD_REQUEST', 'transaction is required');
    return { transaction: deps.clientDomain.coSignChallenge(req.body.transaction, await deps.anchorSigningKey()) };
  });

  return app;
}
