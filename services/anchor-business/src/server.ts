/**
 * Anchor business server: the ANCHOR's side of the cash-in and the cash-out, not Corra's orchestrator.
 *
 * In production this is run by the licensed anchor. Here it plays that role on testnet next to
 * SDF's Anchor Platform: it serves the SEP-24 interactive pages, simulates the SPEI bank transfer,
 * answers the platform's SEP-38 rate callback, and pays TESTMXN with the anchor's OWN
 * distribution key. That key belongs to the anchor; Corra's orchestrator never holds it.
 * Withdrawals (TESTPHP): the recipient confirms on the withdraw page, a poller watches the
 * distribution account for the recipient's payment (exact memo, asset and amount), and the cash
 * pickup is simulated. The more_info page shows any transaction's record.
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
  /** The platform signs more_info URL tokens with HS256 and SECRET_SEP24_MORE_INFO_URL_JWT_SECRET. */
  moreInfoSecret: string;
  /** The withdraw-only asset, same issuer as `assetIssuer`. */
  withdrawAssetCode: string;
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
    moreInfoSecret: get('SEP24_MORE_INFO_URL_JWT_SECRET'),
    withdrawAssetCode: get('WITHDRAW_ASSET_CODE', 'TESTPHP'),
  };
}

const FIAT = 'iso4217:MXN';
const PHP_FIAT = 'iso4217:PHP';
/** Matches max_amount in infra/anchor/config/assets.yaml.tmpl. */
const MAX_DEPOSIT = 1_000_000;
/** Match min_amount and max_amount of TESTPHP withdraw in infra/anchor/config/assets.yaml.tmpl. */
const MIN_WITHDRAW = 1;
const MAX_WITHDRAW = 1_000_000;
/** AP never expires a SEP-24 transaction itself (initial_user_deadline_seconds -1): an unpaid withdrawal expires after this. */
const WITHDRAW_EXPIRY_MS = 24 * 3_600_000;
const LIST_PAGE_SIZE = 50;
/** Bounds one tick's read of open transactions (10,000 records). */
const MAX_LIST_PAGES = 200;
/** A payment may be stamped a little before the platform's started_at (clock skew between the ledger and the platform). */
const SKEW_MS = 60_000;
export const POLL_MS = 5000;

/** The Platform API the business server uses. Injectable for tests. */
export type PlatformClient = {
  rpc(method: string, params: Record<string, unknown>): Promise<any>;
  getTransaction(id: string): Promise<any>;
  /** GET /transactions?sep=24&order_by=created_at&order=asc&statuses=<csv>&page_size=50 */
  listTransactions(statuses: string[]): Promise<any[]>;
};

/** A payment into the distribution account, as Horizon reports it with its transaction. */
export type DistributionPayment = {
  hash: string; to: string; assetCode: string; assetIssuer: string; amount: string;
  memoType: 'none' | 'id' | 'text' | 'hash'; memo: string | null; at: number; successful: boolean;
};

export type PayoutChain = {
  /**
   * Payments to `account`, newest first, back to `since` (ms), at most 10 pages of 200.
   * `complete` is false when that cap stopped the read before `since`: an older payment may be missing.
   */
  paymentsTo(account: string, since: number): Promise<{ payments: DistributionPayment[]; complete: boolean }>;
};

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

type MoreInfoClaims = { jti: string; aud?: string | string[] };

/**
 * The platform's more_info URL token: HS256 with SECRET_SEP24_MORE_INFO_URL_JWT_SECRET, `jti` the
 * transaction id, `aud` (when present) sep24_more_info. `exp` is ignored on purpose: a link a
 * wallet stored must keep working, and the page is read-only with data that is also on chain.
 */
export function verifyMoreInfoJwt(token: string, secret: string): MoreInfoClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (header.alg !== 'HS256') throw new Error('unexpected alg');
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error('bad signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as MoreInfoClaims;
  if (!claims.jti) throw new Error('no transaction id');
  if (claims.aud !== undefined && !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes('sep24_more_info')) {
    throw new Error('token is not for the more_info page');
  }
  return claims;
}

/** A decimal amount in stroops (7 places), or null when it is not one. */
const raw7 = (a: unknown): bigint | null => {
  if (typeof a !== 'string' || !/^\d+(\.\d{1,7})?$/.test(a)) return null;
  const [w, f = ''] = a.split('.');
  return BigInt(w) * 10_000_000n + BigInt(f.padEnd(7, '0'));
};

/** Cuts a decimal to 2 places (PHP has centavos), without rounding up. */
const truncate2 = (a: string) => {
  const [w, f = ''] = a.split('.');
  return f.slice(0, 2) ? `${w}.${f.slice(0, 2)}` : w;
};

const hashBytes = (m: string) => (/^[0-9a-f]{64}$/i.test(m) ? Buffer.from(m, 'hex') : Buffer.from(m, 'base64'));

/** The platform's memo against a payment's: same type, id as a number, text exactly, hash by its bytes; no memo never matches. */
function sameMemo(type: unknown, value: unknown, p: DistributionPayment): boolean {
  if (typeof value !== 'string' || !value || p.memo === null || p.memoType !== type) return false;
  if (type === 'id') return /^\d{1,20}$/.test(value) && /^\d{1,20}$/.test(p.memo) && BigInt(value) === BigInt(p.memo);
  if (type === 'text') return value === p.memo;
  if (type === 'hash') {
    const a = hashBytes(value);
    const b = hashBytes(p.memo);
    return a.length === 32 && a.equals(b);
  }
  return false;
}

/**
 * The payment that pays a withdrawal `tx` (a platform record in pending_user_transfer_start):
 * a successful payment to the distribution account in the withdraw asset, at or after the
 * withdrawal started, carrying the memo the platform generated. The oldest of exactly the expected
 * amount is a match; candidates of other amounts only are `wrong_amount`. `payments` newest first. Pure.
 */
export function matchWithdrawal(tx: any, payments: DistributionPayment[], distribution: string, asset: { code: string; issuer: string }):
  { kind: 'match'; hash: string } | { kind: 'wrong_amount'; hash: string; amount: string } | null {
  const started = Date.parse(tx?.started_at);
  const expected = raw7(tx?.amount_expected?.amount);
  if (!Number.isFinite(started) || expected === null) return null;
  const candidates = payments.filter((p) => p.successful && p.to === distribution && p.assetCode === asset.code &&
    p.assetIssuer === asset.issuer && p.at >= started - SKEW_MS && sameMemo(tx.memo_type, tx.memo, p));
  // The oldest exact one: the memo is public before the payment lands, so a later copy must not win.
  // `payments` come newest first (Horizon desc), so reversing keeps a ledger's own order on equal times.
  const exact = candidates.filter((p) => raw7(p.amount) === expected).reverse().sort((a, b) => a.at - b.at)[0];
  if (exact) return { kind: 'match', hash: exact.hash };
  return candidates.length ? { kind: 'wrong_amount', hash: candidates[0].hash, amount: candidates[0].amount } : null;
}

/** The default PlatformClient: JSON-RPC and REST against the Platform API. */
export function createPlatformClient(platformApi: string): PlatformClient {
  return {
    async rpc(method, params) {
      const r = await fetch(platformApi, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }]),
      });
      const body = await r.json();
      const res = Array.isArray(body) ? body[0] : body;
      if (!r.ok || res?.error) throw new Error(`${method}: ${JSON.stringify(res?.error ?? body)}`);
      return res.result;
    },
    async getTransaction(id) {
      const r = await fetch(`${platformApi}/transactions/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`platform GET /transactions/${id}: ${r.status}`);
      return r.json();
    },
    async listTransactions(statuses) {
      // Every page (page_number is 0-based): abandoned withdrawals stay open for 24 h and must not hide newer ones.
      const out: any[] = [];
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const q = new URLSearchParams({
          sep: '24', order_by: 'created_at', order: 'asc', statuses: statuses.join(','), page_size: String(LIST_PAGE_SIZE), page_number: String(page),
        });
        const r = await fetch(`${platformApi}/transactions?${q}`);
        if (!r.ok) throw new Error(`platform GET /transactions: ${r.status}`);
        const records = ((await r.json()).records ?? []) as any[];
        out.push(...records);
        if (records.length < LIST_PAGE_SIZE) break;
      }
      return out;
    },
  };
}

/** Horizon's payments to the distribution account, joined with their transactions for the memo. */
export function createHorizonPayoutChain(horizonUrl: string): PayoutChain {
  const horizon = new S.Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith('http://') });
  return {
    async paymentsTo(account, since) {
      const out: DistributionPayment[] = [];
      let page = await horizon.payments().forAccount(account).join('transactions').order('desc').limit(200).call();
      for (let pages = 0; pages < 10 && page.records.length; pages++) {
        for (const r of page.records as any[]) {
          const at = Date.parse(r.created_at);
          if (at < since) return { payments: out, complete: true };
          if (r.type !== 'payment') continue;
          const t = r.transaction_attr;
          out.push({
            hash: r.transaction_hash, to: r.to, assetCode: r.asset_code ?? 'XLM', assetIssuer: r.asset_issuer ?? '', amount: r.amount,
            memoType: t?.memo_type ?? 'none', memo: t?.memo ?? null, at, successful: !!r.transaction_successful,
          });
        }
        if (page.records.length < 200) return { payments: out, complete: true };
        page = await page.next();
      }
      // Ten full pages: complete only if Horizon has nothing older.
      return { payments: out, complete: !page.records.length };
    },
  };
}

/**
 * The anchor's payout side of a withdrawal, one tick every POLL_MS: a recipient's payment that
 * matches a pending withdrawal is reported received; a received one gets its (simulated) cash
 * pickup and completes; an unpaid one expires after 24 hours. Deposits pass through the same
 * statuses and are never touched. Every RPC error is logged; the next tick retries.
 */
export function createPayoutPoller(d: { cfg: BusinessConfig; platform: PlatformClient; chain: PayoutChain; log: (o: object) => void; now?: () => number }) {
  const now = d.now ?? Date.now;
  const asset = { code: d.cfg.withdrawAssetCode, issuer: d.cfg.assetIssuer };
  const stellarAsset = `stellar:${asset.code}:${asset.issuer}`;
  const distribution = S.Keypair.fromSecret(d.cfg.distributionSecret).publicKey();

  /** True only when the RPC resolved: the success event is logged only then. */
  async function step(tx: any, what: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      d.log({ evt: 'withdraw.rpc_failed', id: tx.id, what, error: (e as Error).message });
      return false;
    }
  }

  async function tick() {
    const all = await d.platform.listTransactions(['pending_user_transfer_start', 'pending_anchor']);
    const txs = all.filter((tx) => tx?.kind === 'withdrawal' && tx.amount_expected?.asset === stellarAsset);
    const t = now();
    const waiting: any[] = [];
    for (const tx of txs) {
      if (tx.status === 'pending_anchor') {
        const ok = await step(tx, 'notify_offchain_funds_sent', () => d.platform.rpc('notify_offchain_funds_sent', {
          transaction_id: tx.id, message: 'cash pickup simulated (testnet)', funds_sent_at: new Date(t).toISOString(),
          external_transaction_id: 'sim-cash-pickup-' + String(tx.id).slice(0, 8),
        }));
        if (ok) d.log({ evt: 'withdraw.paid_out', id: tx.id });
      } else {
        waiting.push(tx);
      }
    }
    if (!waiting.length) return;
    // Expiring ones are matched too (from their own start): one paid but missed by an earlier tick is received, not expired.
    const earliest = Math.min(...waiting.map((tx) => Date.parse(tx.started_at)));
    const { payments, complete } = await d.chain.paymentsTo(distribution, earliest - SKEW_MS);
    for (const tx of waiting) {
      const m = matchWithdrawal(tx, payments, distribution, asset);
      if (!m && t - Date.parse(tx.started_at) > WITHDRAW_EXPIRY_MS) {
        // Its payment may lie beyond a truncated window: never expire a withdrawal that may be paid.
        if (!complete) {
          d.log({ evt: 'withdraw.window_incomplete', id: tx.id, since: earliest - SKEW_MS });
          continue;
        }
        await step(tx, 'notify_transaction_expired', () => d.platform.rpc('notify_transaction_expired', {
          transaction_id: tx.id, message: 'no payment within 24 hours',
        }));
      } else if (m?.kind === 'match') {
        const ok = await step(tx, 'notify_onchain_funds_received', () => d.platform.rpc('notify_onchain_funds_received', {
          transaction_id: tx.id, message: `${asset.code} received`, stellar_transaction_id: m.hash, amount_in: { amount: tx.amount_expected.amount },
        }));
        if (ok) d.log({ evt: 'withdraw.received', id: tx.id, hash: m.hash });
      } else if (m?.kind === 'wrong_amount') {
        // Only an out-of-band payment can get here: Corra pins the amount. No refund on testnet.
        const ok = await step(tx, 'notify_transaction_error', () => d.platform.rpc('notify_transaction_error', {
          transaction_id: tx.id, message: `payment ${m.hash} of ${m.amount} ${asset.code} does not match the expected ${tx.amount_expected.amount}`,
        }));
        if (ok) d.log({ evt: 'withdraw.mismatch', id: tx.id, hash: m.hash, amount: m.amount });
      }
    }
  }

  return { tick };
}

const isAmount = (a: unknown): a is string => typeof a === 'string' && /^\d+(\.\d{1,7})?$/.test(a) && Number(a) > 0;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Test anchor deposit</title>
<style>body{font-family:system-ui,sans-serif;max-width:440px;margin:40px auto;padding:0 16px;color:#111}
.box{border:1px solid #ddd;padding:16px;margin:16px 0}code{font-size:15px}button{padding:12px 16px;font-size:15px;cursor:pointer}
input{padding:8px;font-size:15px;width:100%;box-sizing:border-box}.muted{color:#666;font-size:13px}</style></head><body>${body}</body></html>`;

/** The read-only withdraw page: the amount comes from the platform record, never from the user. */
function withdrawPage(token: string, jti: string, tx: any) {
  const amount: string | undefined = tx.amount_expected?.amount;
  const body = amount
    ? `<p>Amount <code>${esc(amount)} TESTPHP</code></p>
<div class="box">Payout: simulated cash pickup, Manila. Test anchor: no cash moves.</div>
<button id="go">Confirm withdrawal</button>
<p id="out"></p>
<script>
const go = document.getElementById('go');
go.onclick = async () => {
  // One request per click: the button comes back only on an error.
  go.disabled = true;
  const out = document.getElementById('out'); out.textContent = 'Processing...';
  try {
    const r = await fetch('/sep24/withdraw-confirm', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ${JSON.stringify(token)} }) });
    const j = await r.json();
    if (r.ok) {
      out.textContent = 'Confirmed. Go back to Corra and sign the withdrawal there. Corra pays the network fee. You can close this window.';
      return;
    }
    out.textContent = 'Error: ' + (j.error || r.status);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
  go.disabled = false;
};
</script>`
    : '<p>This withdrawal has no amount. Start it again from Corra.</p>';
  return page(`
<h2>Withdraw TESTPHP (testnet anchor)</h2>
<p class="muted">Transaction ${esc(jti)}</p>
${body}`);
}

const field = (label: string, value: unknown) =>
  value === undefined || value === null || value === '' ? '' : `<tr><td class="muted">${esc(label)}</td><td><code>${esc(String(value))}</code></td></tr>`;

export function buildServer(cfg: BusinessConfig, opts: { logger?: boolean; platform?: PlatformClient } = {}) {
  const horizon = new S.Horizon.Server(cfg.horizonUrl, { allowHttp: cfg.horizonUrl.startsWith('http://') });
  const distribution = S.Keypair.fromSecret(cfg.distributionSecret);
  const asset = new S.Asset(cfg.assetCode, cfg.assetIssuer);
  const stellarAsset = `stellar:${cfg.assetCode}:${cfg.assetIssuer}`;
  const withdrawAsset = `stellar:${cfg.withdrawAssetCode}:${cfg.assetIssuer}`;
  const app = Fastify({ logger: opts.logger ?? true });
  const { rpc, getTransaction } = opts.platform ?? createPlatformClient(cfg.platformApi);

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
    let platformTx: any;
    try {
      platformTx = await getTransaction(claims.jti);
    } catch {
      return reply.code(502).type('text/html').send(page('<h2>Test anchor</h2><p>The anchor could not load this transaction. Try again.</p>'));
    }
    if (platformTx?.kind === 'withdrawal') return reply.type('text/html').send(withdrawPage(token, claims.jti, platformTx));
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
    // A withdrawal's interactive token is signed with the same secret: it must never run a deposit settlement.
    if (platformTx?.kind !== 'deposit') return reply.code(409).send({ error: 'not a deposit' });
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

  /** The recipient confirms the withdrawal; the platform then generates the memo and waits for the payment. */
  app.post<{ Body: { token?: string } }>('/sep24/withdraw-confirm', async (req, reply) => {
    let claims: InteractiveClaims;
    try {
      claims = verifyInteractiveJwt(req.body?.token ?? '', cfg.jwtSecret, Math.floor(Date.now() / 1000));
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }
    let tx: any;
    try {
      tx = await getTransaction(claims.jti);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    if (tx.kind !== 'withdrawal') return reply.code(409).send({ error: 'not a withdrawal' });
    // A second click: already confirmed, nothing to do.
    if (tx.status === 'pending_user_transfer_start') return { transaction_id: claims.jti, status: tx.status };
    if (tx.status !== 'incomplete') return reply.code(409).send({ error: `withdrawal is already ${tx.status}` });
    if (tx.amount_expected?.asset !== withdrawAsset) return reply.code(400).send({ error: `only ${cfg.withdrawAssetCode} can be withdrawn here` });
    const amount: unknown = tx.amount_expected?.amount;
    const raw = raw7(amount);
    if (raw === null || raw < BigInt(MIN_WITHDRAW) * 10_000_000n || raw > BigInt(MAX_WITHDRAW) * 10_000_000n) {
      return reply.code(400).send({ error: `amount must be between ${MIN_WITHDRAW} and ${MAX_WITHDRAW}` });
    }
    const x = amount as string;
    try {
      // No memo, memo_type or destination_account: the platform generates both and refuses them here.
      await rpc('request_onchain_funds', {
        transaction_id: claims.jti,
        message: `confirmed by the recipient; waiting for the ${cfg.withdrawAssetCode} payment`,
        amount_in: { asset: withdrawAsset, amount: x },
        amount_out: { asset: PHP_FIAT, amount: truncate2(x) },
        amount_expected: { amount: x },
        fee_details: { total: '0', asset: withdrawAsset },
      });
    } catch (e) {
      // A concurrent confirm (a double click) won: the platform refused this one, but the withdrawal is confirmed.
      const now = await getTransaction(claims.jti).catch(() => null);
      if (now?.status === 'pending_user_transfer_start') return { transaction_id: claims.jti, status: now.status };
      // No notify_transaction_error: the recipient can press again.
      req.log.error(e);
      return reply.code(502).send({ error: (e as Error).message });
    }
    return { transaction_id: claims.jti, status: 'pending_user_transfer_start' };
  });

  /** Any transaction's record, from the platform: the anchor's evidence page. */
  app.get<{ Querystring: Record<string, string> }>('/sep24/more_info', async (req, reply) => {
    let claims: MoreInfoClaims;
    try {
      claims = verifyMoreInfoJwt(req.query.token ?? '', cfg.moreInfoSecret);
      if (req.query.transaction_id !== undefined && req.query.transaction_id !== claims.jti) throw new Error('transaction id does not match the token');
    } catch (e) {
      return reply.code(401).type('text/html').send(page(`<h2>Invalid link</h2><p>${esc((e as Error).message)}</p>`));
    }
    let tx: any;
    try {
      tx = await getTransaction(claims.jti);
    } catch {
      return reply.code(502).type('text/html').send(page('<h2>Test anchor</h2><p>The anchor could not load this transaction. Try again.</p>'));
    }
    const withdrawal = tx.kind === 'withdrawal';
    const stellarTx: string | undefined = tx.stellar_transaction_id ?? tx.stellar_transactions?.[0]?.id;
    const amount = (m: any) => (m?.amount ? `${m.amount} ${String(m.asset ?? '').split(':').slice(0, 2).join(':')}` : undefined);
    return reply.type('text/html').send(page(`
<h2>Test anchor transaction</h2>
<table>
${field('Transaction', tx.id)}${field('Kind', tx.kind)}${field('Status', tx.status)}
${field('Amount in', amount(tx.amount_in))}${field('Amount out', amount(tx.amount_out))}
${field('Paid to (anchor account)', withdrawal ? tx.withdraw_anchor_account ?? tx.destination_account : undefined)}
${stellarTx ? `<tr><td class="muted">Stellar transaction</td><td><a target="_blank" rel="noopener noreferrer" href="https://stellar.expert/explorer/testnet/tx/${esc(stellarTx)}"><code>${esc(stellarTx)}</code></a></td></tr>` : ''}
${field('Payout reference', tx.external_transaction_id)}${field('Completed at', tx.completed_at)}
</table>
<p class="muted">${withdrawal ? 'Payout simulated (testnet). No cash moved.' : 'Bank transfer simulated (testnet). No cash moved.'}</p>`));
  });

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
