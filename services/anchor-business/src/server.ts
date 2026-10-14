/**
 * Anchor business server: the ANCHOR's side of the cash-in, not Corra's orchestrator.
 *
 * In production this is run by the licensed anchor. Here it plays that role on testnet next to
 * SDF's Anchor Platform: it serves the SEP-24 interactive page, simulates the SPEI bank transfer,
 * answers the platform's SEP-38 rate callback, and pays TESTMXN with the anchor's OWN
 * distribution key. That key belongs to the anchor; Corra's orchestrator never holds it.
 */
import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import * as S from '@stellar/stellar-sdk';

export type BusinessConfig = {
  platformApi: string;
  jwtSecret: string;
  horizonUrl: string;
  networkPassphrase: string;
  distributionSecret: string;
  assetCode: string;
  assetIssuer: string;
};

export function configFromEnv(env = process.env): BusinessConfig & { port: number } {
  const get = (k: string, d?: string) => {
    const v = env[k] ?? d;
    if (v === undefined) throw new Error(`${k} is not set`);
    return v;
  };
  return {
    port: Number(get('PORT', '8091')),
    platformApi: get('PLATFORM_API_URL', 'http://platform:8085'),
    jwtSecret: get('SEP24_INTERACTIVE_URL_JWT_SECRET'),
    horizonUrl: get('HORIZON_URL', 'https://horizon-testnet.stellar.org'),
    networkPassphrase: get('NETWORK_PASSPHRASE', S.Networks.TESTNET),
    distributionSecret: get('ANCHOR_DISTRIBUTION_SECRET'),
    assetCode: get('ASSET_CODE', 'TESTMXN'),
    assetIssuer: get('ASSET_ISSUER'),
  };
}

const FIAT = 'iso4217:MXN';
/** Matches max_amount in infra/anchor/config/assets.yaml.tmpl. */
const MAX_DEPOSIT = 1_000_000;

type InteractiveClaims = { jti: string; sub?: string; exp: number; data?: Record<string, string> };

/** The platform signs the interactive URL token with HS256 and SECRET_SEP24_INTERACTIVE_URL_JWT_SECRET. */
export function verifyInteractiveJwt(token: string, secret: string, nowSec: number): InteractiveClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (header.alg !== 'HS256') throw new Error('unexpected alg');
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('bad signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as InteractiveClaims;
  if (!claims.jti) throw new Error('no transaction id');
  if (!claims.exp || claims.exp < nowSec) throw new Error('token expired');
  return claims;
}

const isAmount = (a: unknown): a is string => typeof a === 'string' && /^\d+(\.\d{1,7})?$/.test(a) && Number(a) > 0;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Test anchor deposit</title>
<style>body{font-family:system-ui,sans-serif;max-width:440px;margin:40px auto;padding:0 16px;color:#111}
.box{border:1px solid #ddd;padding:16px;margin:16px 0}code{font-size:15px}button{padding:12px 16px;font-size:15px;cursor:pointer}
input{padding:8px;font-size:15px;width:100%;box-sizing:border-box}.muted{color:#666;font-size:13px}</style></head><body>${body}</body></html>`;

export function buildServer(cfg: BusinessConfig, opts: { logger?: boolean } = {}) {
  const horizon = new S.Horizon.Server(cfg.horizonUrl, { allowHttp: cfg.horizonUrl.startsWith('http://') });
  const distribution = S.Keypair.fromSecret(cfg.distributionSecret);
  const asset = new S.Asset(cfg.assetCode, cfg.assetIssuer);
  const stellarAsset = `stellar:${cfg.assetCode}:${cfg.assetIssuer}`;
  const app = Fastify({ logger: opts.logger ?? true });

  async function rpc(method: string, params: Record<string, unknown>) {
    const r = await fetch(cfg.platformApi, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }]),
    });
    const body = await r.json();
    const res = Array.isArray(body) ? body[0] : body;
    if (!r.ok || res?.error) throw new Error(`${method}: ${JSON.stringify(res?.error ?? body)}`);
    return res.result;
  }

  async function getTransaction(id: string) {
    const r = await fetch(`${cfg.platformApi}/transactions/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(`platform GET /transactions/${id}: ${r.status}`);
    return r.json();
  }

  async function pay(destination: string, amount: string, memo?: string, memoType?: string) {
    const acct = await horizon.loadAccount(distribution.publicKey());
    const b = new S.TransactionBuilder(acct, { fee: '1000', networkPassphrase: cfg.networkPassphrase })
      .addOperation(S.Operation.payment({ destination, asset, amount }))
      .setTimeout(120);
    // Clients send hash memos base64 (SEP-24); the platform stores them hex. Accept either.
    const hashBytes = (m: string) => (/^[0-9a-f]{64}$/i.test(m) ? Buffer.from(m, 'hex') : Buffer.from(m, 'base64'));
    if (memo) b.addMemo(memoType === 'id' ? S.Memo.id(memo) : memoType === 'hash' ? S.Memo.hash(hashBytes(memo)) : S.Memo.text(memo));
    const tx = b.build();
    tx.sign(distribution);
    return (await horizon.submitTransaction(tx)).hash;
  }

  /** Runs the SEP-24 deposit once the (simulated) SPEI transfer has arrived. */
  async function settleDeposit(txId: string, amount: string) {
    await rpc('request_offchain_funds', {
      transaction_id: txId,
      message: 'waiting for the SPEI transfer',
      amount_in: { asset: FIAT, amount },
      amount_out: { asset: stellarAsset, amount },
      fee_details: { total: '0', asset: FIAT },
    });
    await rpc('notify_offchain_funds_received', {
      transaction_id: txId,
      message: 'SPEI transfer received (simulated)',
      funds_received_at: new Date().toISOString(),
    });
    const tx = await getTransaction(txId);
    const destination: string | undefined = tx.destination_account ?? tx.to;
    if (!destination) throw new Error('transaction has no destination account');
    const hash = await pay(destination, amount, tx.memo, tx.memo_type);
    await rpc('notify_onchain_funds_sent', { transaction_id: txId, message: 'TESTMXN sent', stellar_transaction_id: hash });
    return hash;
  }

  app.get('/health', async () => ({ ok: true }));

  app.get<{ Querystring: Record<string, string> }>('/sep24/interactive', async (req, reply) => {
    const token = req.query.token ?? '';
    let claims: InteractiveClaims;
    try {
      claims = verifyInteractiveJwt(token, cfg.jwtSecret, Math.floor(Date.now() / 1000));
    } catch (e) {
      return reply.code(401).type('text/html').send(page(`<h2>Invalid session</h2><p>${esc((e as Error).message)}</p>`));
    }
    const amount = req.query['data.amount'] ?? claims.data?.amount ?? '';
    return reply.type('text/html').send(page(`
<h2>Deposit MXN (testnet anchor)</h2>
<p class="muted">Transaction ${esc(claims.jti)}</p>
<label>Amount (MXN)<br><input id="amount" value="${esc(amount)}" inputmode="decimal" readonly></label>
<div class="box">Send a SPEI transfer to<br>CLABE <code>646 180 1570 0000 0007</code><br>
Reference <code>${esc(claims.jti.slice(0, 8).toUpperCase())}</code></div>
<p class="muted">Test anchor: no bank exists. The button below stands in for the bank confirming the transfer.</p>
<button id="go">Simulate SPEI transfer received</button>
<p id="out"></p>
<script>
document.getElementById('go').onclick = async () => {
  const out = document.getElementById('out'); out.textContent = 'Processing...';
  const r = await fetch('/sep24/simulate', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: ${JSON.stringify(token)}, amount: document.getElementById('amount').value }) });
  const j = await r.json();
  out.innerHTML = r.ok ? 'Done. TESTMXN sent: <a target="_blank" href="https://stellar.expert/explorer/testnet/tx/' + j.stellar_transaction_id + '">' + j.stellar_transaction_id.slice(0, 12) + '...</a>. You can close this window.'
    : 'Error: ' + (j.error || r.status);
};
</script>`));
  });

  app.post<{ Body: { token?: string; amount?: string } }>('/sep24/simulate', async (req, reply) => {
    let claims: InteractiveClaims;
    try {
      claims = verifyInteractiveJwt(req.body?.token ?? '', cfg.jwtSecret, Math.floor(Date.now() / 1000));
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }
    const amount = req.body?.amount;
    if (!isAmount(amount)) return reply.code(400).send({ error: 'amount must be a positive decimal with at most 7 places' });
    // The simulated bank transfer must be exactly what the deposit asked for, and only once:
    // a session token must not let anyone choose how much TESTMXN the anchor pays out.
    let platformTx: any;
    try {
      platformTx = await getTransaction(claims.jti);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    if (platformTx.status !== 'incomplete') {
      return reply.code(409).send({ error: `deposit is already ${platformTx.status}` });
    }
    const expected: string | undefined = platformTx.amount_expected?.amount;
    if (expected ? Number(expected) !== Number(amount) : Number(amount) > MAX_DEPOSIT) {
      return reply.code(400).send({ error: expected ? `amount must equal the requested deposit, ${expected}` : `amount above ${MAX_DEPOSIT}` });
    }
    try {
      const hash = await settleDeposit(claims.jti, amount);
      return { transaction_id: claims.jti, stellar_transaction_id: hash };
    } catch (e) {
      req.log.error(e);
      await rpc('notify_transaction_error', { transaction_id: claims.jti, message: (e as Error).message }).catch(() => {});
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get('/sep24/more_info', async (_req, reply) =>
    reply.type('text/html').send(page('<h2>Test anchor</h2><p>Deposit status is tracked by your wallet.</p>')));

  /** SEP-38 rate callback. TESTMXN is a test token pegged 1:1 to MXN, with no fee. */
  app.get<{ Querystring: Record<string, string> }>('/rate', async (req, reply) => {
    const q = req.query;
    const pair = [q.sell_asset, q.buy_asset].sort().join('|');
    if (pair !== [FIAT, stellarAsset].sort().join('|')) {
      return reply.code(422).send({ error: `no price for ${q.sell_asset} -> ${q.buy_asset}` });
    }
    if (q.type !== 'indicative' && q.type !== 'firm') return reply.code(400).send({ error: 'type must be indicative or firm' });
    const amount = q.sell_amount ?? q.buy_amount;
    if (!isAmount(amount) || (q.sell_amount && q.buy_amount)) {
      return reply.code(400).send({ error: 'exactly one of sell_amount or buy_amount is required' });
    }
    const rate: Record<string, unknown> = { price: '1', sell_amount: amount, buy_amount: amount, fee: { total: '0', asset: q.sell_asset } };
    if (q.type === 'firm') {
      rate.id = crypto.randomUUID();
      rate.expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }
    return { rate };
  });

  /** Event callbacks are disabled in our platform config; accepted anyway so the toggle never breaks the flow. */
  app.post('/event', async () => ({}));

  return app;
}
