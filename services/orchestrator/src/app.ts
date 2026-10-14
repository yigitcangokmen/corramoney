import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  FIAT,
  corridorFromWire,
  moneyFromWire,
  paymentToWire,
  quoteToWire,
  type FiatCode,
  type MoneyWire,
} from '@corra/shared';
import { SagaError, type Saga } from '@corra/settlement-saga';
import { SponsorRefusal } from '@corra/stellar';
import { parseSep24Callback, verifyCallbackSignature } from './callback';
import { ChallengeRefusal } from './client-domain';
import { createLimiter } from './rate-limit';

export type AppDeps = {
  saga: Saga;
  networkPassphrase: string;
  corsOrigins: string[];
  clientDomain: { publicKey: string; coSignChallenge(xdr: string, anchorSigningKey: string): string };
  /** Builds and sponsor-signs a CAP-33 setup transaction for the account to co-sign. */
  prepareSetup(account: string, trust: FiatCode[]): Promise<string>;
  anchorSigningKey(): Promise<string>;
  now?: () => number;
  log?: boolean;
  /** Per-route budgets; tests may loosen them. */
  limits?: Partial<typeof DEFAULT_LIMITS>;
};

/**
 * The sponsor pays real reserves for every setup, so /setup is the expensive route: a few per IP,
 * one per account, and a global hourly ceiling that bounds what any caller can make it lock up.
 */
const DEFAULT_LIMITS = {
  setupPerIp: { max: 5, windowMs: 10 * 60_000 },
  setupPerAccount: { max: 1, windowMs: 10 * 60_000 },
  setupGlobal: { max: 60, windowMs: 60 * 60_000 },
  quotePerIp: { max: 60, windowMs: 60_000 },
  clientDomainPerIp: { max: 30, windowMs: 60_000 },
};

const SSE_MAX_MS = 35 * 60_000;

const fail = (reply: FastifyReply, status: number, code: string, message: string, retriable = false) =>
  reply.code(status).send({ error: { code, message, retriable } });

const G = /^G[A-Z2-7]{55}$/;

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
    if (err instanceof SponsorRefusal || err instanceof ChallengeRefusal) return fail(reply, 422, 'REFUSED', err.message);
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
    return reply.code(201).send(paymentToWire(await deps.saga.resign(supersedesId, quoteId, signedXdr, idemKey, anchorQuote)));
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
    while (!closed && now() < until) {
      const events = await deps.saga.events(p.id);
      for (const e of events.slice(sent)) reply.raw.write(`event: state\ndata: ${JSON.stringify(e)}\n\n`);
      sent = events.length;
      const last = events.at(-1);
      if (last?.to && deps.saga.isTerminal(last.to)) break;
      await new Promise((r) => setTimeout(r, 1000));
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
    // Always a fast 200 so the anchor does not retry; the callback is only a trigger.
    if (ev) deps.saga.onCashIn(ev).catch((e) => app.log.error(e));
    return { ok: true };
  });

  app.post<{ Body: { account: string; trust?: unknown } }>('/setup', async (req, reply) => {
    const account = req.body?.account;
    if (!G.test(account ?? '')) return fail(reply, 400, 'BAD_REQUEST', 'account is required');
    const trust = req.body.trust ?? ['MXN'];
    if (!Array.isArray(trust) || trust.length < 1 || trust.length > 2 || new Set(trust).size !== trust.length ||
        !trust.every((c) => typeof c === 'string' && Object.hasOwn(FIAT, c))) {
      return fail(reply, 400, 'BAD_REQUEST', `trust must be one or two distinct codes of ${Object.keys(FIAT).join(', ')}`);
    }
    if (!lim.setupPerIp.take(req.ip) || !lim.setupPerAccount.take(account) || !lim.setupGlobal.take('all')) {
      return limited(reply);
    }
    return { xdr: await deps.prepareSetup(account, trust as FiatCode[]) };
  });

  app.post<{ Body: { transaction: string } }>('/sep10/client-domain', async (req, reply) => {
    if (!lim.clientDomainPerIp.take(req.ip)) return limited(reply);
    if (typeof req.body?.transaction !== 'string') return fail(reply, 400, 'BAD_REQUEST', 'transaction is required');
    return { transaction: deps.clientDomain.coSignChallenge(req.body.transaction, await deps.anchorSigningKey()) };
  });

  return app;
}
