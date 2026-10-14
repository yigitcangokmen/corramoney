/**
 * Drives one payment through the orchestrator's HTTP API to CREDITED on testnet.
 * Keypairs stand in for Freighter. Used by the quickstart CI job.
 *
 *   ORCHESTRATOR_URL=http://localhost:8787 pnpm drive-payment
 *
 * Cash-in (CASH_IN):
 *   anchor (default)  SEP-10 with Corra's client_domain, SEP-24 deposit at the Anchor Platform,
 *                     simulated SPEI at the anchor's business server; the anchor's signed
 *                     callback triggers the orchestrator.
 *   direct            no anchor running: the anchor distribution account pays the sender itself.
 *   lost              like direct, but nothing tells the orchestrator: proves the reconciler
 *                     recovers a lost callback from chain state alone.
 */
import * as S from '@stellar/stellar-sdk';
import { PublicKeypair, Wallet } from '@stellar/typescript-wallet-sdk';
import { readFileSync } from 'node:fs';
import { cashInMemo, fiatAsset, moneyFromWire, roundUp, TESTNET, toDecimal } from '../packages/shared/src';
import { buildStrictReceive } from '../packages/stellar/src';

const API = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8787';
const NP = TESTNET.networkPassphrase;
const horizon = new S.Horizon.Server(TESTNET.horizonUrl);
const link = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;

const env = Object.fromEntries(
  readFileSync('.env.testnet', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

async function api(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(json)}`);
  return json;
}

const ANCHOR_DOMAIN = process.env.ANCHOR_DOMAIN ?? 'localhost:8080';
const anchorClient = () => Wallet.TestNet().anchor({ homeDomain: ANCHOR_DOMAIN, allowHttp: ANCHOR_DOMAIN.startsWith('localhost') });

/** SEP-10 with Corra's client_domain co-signature, as the app does on connect. */
async function anchorLogin(user: S.Keypair) {
  const clientDomain = process.env.CORRA_CLIENT_DOMAIN ?? 'host.docker.internal:8787';
  const sep10: any = await anchorClient().sep10();
  const ch = await sep10.challenge({ accountKp: PublicKeypair.fromPublicKey(user.publicKey()), clientDomain });
  const { transaction } = await api('POST', '/sep10/client-domain', { transaction: ch.transaction });
  const signed = S.TransactionBuilder.fromXDR(transaction, NP) as S.Transaction;
  signed.sign(user);
  return sep10.getToken(signed);
}

/** The anchor's SEP-38 firm quote for depositing `buyAmount` TESTMXN, paid in MXN by SPEI. */
async function anchorFirmQuote(token: any, buyAmount: string) {
  return anchorClient().sep38(token).requestQuote({
    context: 'sep24', sell_asset: 'iso4217:MXN', buy_asset: `stellar:TESTMXN:${TESTNET.corridorIssuer}`,
    buy_amount: buyAmount, sell_delivery_method: 'SPEI', country_code: 'MX',
  } as any);
}

/** The sender's cash-in through the Anchor Platform. The keypair stands in for Freighter. */
async function anchorCashIn(token: any, paymentId: string, amount: string, quoteId?: string) {
  const business = process.env.ANCHOR_BUSINESS_URL ?? 'http://localhost:8091';
  const memo = await cashInMemo(paymentId);
  const dep = await anchorClient().sep24().deposit({
    assetCode: 'TESTMXN', authToken: token,
    extraFields: { amount, memo, memo_type: 'hash', ...(quoteId ? { quote_id: quoteId } : {}) },
  });
  const domain = ANCHOR_DOMAIN;
  await api('POST', `/payments/${paymentId}/cash-in`, { ref: dep.id });
  console.log(`cash-in   SEP-24 deposit ${dep.id} at ${domain}, linked to the payment`);

  const r = await fetch(`${business}/sep24/simulate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URL(dep.url!).searchParams.get('token'), amount }),
  });
  const sim = await r.json();
  if (!r.ok) throw new Error(`simulate -> ${r.status} ${JSON.stringify(sim)}`);
  console.log(`          simulated SPEI, anchor paid ${link(sim.stellar_transaction_id)}`);
}

async function setup(user: S.Keypair, trust: string[]) {
  const { xdr } = await api('POST', '/setup', { account: user.publicKey(), trust });
  const tx = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
  tx.sign(user);
  return (await horizon.submitTransaction(tx)).hash;
}

async function main() {
  const sender = S.Keypair.random();
  const recipient = S.Keypair.random();
  console.log(`orchestrator ${API}\nsender    ${sender.publicKey()}\nrecipient ${recipient.publicKey()}`);

  console.log(`\nsetup (sponsored, 0 XLM)\n  sender    ${link(await setup(sender, ['MXN']))}\n  recipient ${link(await setup(recipient, ['PHP']))}`);

  const php = fiatAsset('PHP');
  const q = await api('POST', '/quote', {
    corridor: { from: 'MX/MXN', to: 'PH/PHP' },
    destAmount: { amount: '1000', asset: php.code, issuer: php.issuer },
  });
  console.log(`\nQUOTED ${q.id}: pay up to ${q.maxSend.amount} TESTMXN, recipient gets ${q.dest.amount} TESTPHP via ${q.path.map((p: any) => p.code).join(' -> ')}`);

  // SPEI moves whole centavos, so the deposit is the signed cap rounded up to 2 decimals.
  const depositAmount = toDecimal(roundUp(moneyFromWire(q.maxSend), 2));
  const viaAnchor = (process.env.CASH_IN ?? 'anchor') === 'anchor';
  const token = viaAnchor ? await anchorLogin(sender) : null;
  const aq = viaAnchor ? await anchorFirmQuote(token, depositAmount) : null;
  if (aq) console.log(`SEP-38 firm quote ${aq.id}: ${aq.sell_amount} MXN -> ${aq.buy_amount} TESTMXN, until ${aq.expires_at}`);

  const acct = await horizon.loadAccount(sender.publicKey());
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), senderSequence: acct.sequence, recipient: recipient.publicKey(),
    dest: moneyFromWire(q.dest), sendMax: moneyFromWire(q.maxSend), path: q.path, now: Math.floor(Date.now() / 1000),
  });
  tx.sign(sender);
  const p = await api('POST', '/confirm', {
    quoteId: q.id, sender: sender.publicKey(), recipient: recipient.publicKey(), signedXdr: tx.toXDR(),
    ...(aq ? { anchorQuote: { id: aq.id, expiresAt: Date.parse(aq.expires_at) } } : {}),
  }, { 'idempotency-key': crypto.randomUUID() });
  console.log(`SIGNED ${p.publicId} (${p.id}), sender holds 0 TESTMXN, tab may close now`);
  if (aq) console.log(`          anchor quote recorded unchanged: ${p.quote.anchorQuoteId}`);

  if (viaAnchor) {
    await anchorCashIn(token, p.id, depositAmount, aq?.id);
  } else {
    const anchor = S.Keypair.fromSecret(env.ANCHOR_DISTRIBUTION_SECRET);
    const a = await horizon.loadAccount(anchor.publicKey());
    const mxn = fiatAsset('MXN');
    const dep = new S.TransactionBuilder(a, { fee: '1000', networkPassphrase: NP })
      .addOperation(S.Operation.payment({ destination: sender.publicKey(), asset: new S.Asset(mxn.code, mxn.issuer), amount: toDecimal(moneyFromWire(q.maxSend)) }))
      .addMemo(S.Memo.hash(Buffer.from(await cashInMemo(p.id), 'base64')))
      .setTimeout(60).build();
    dep.sign(anchor);
    console.log(`cash-in (direct, no anchor) ${link((await horizon.submitTransaction(dep)).hash)}`);
    if (process.env.CASH_IN === 'lost') {
      console.log('          lost callback: the orchestrator is never told; the reconciler must find the deposit on chain');
    } else {
      await api('POST', `/payments/${p.id}/cash-in`, { ref: `direct-${p.id}` });
    }
  }
  for (let i = 0; i < 60; i++) {
    const cur = await api('GET', `/payments/${p.id}`);
    if (['CREDITED', 'EXPIRED', 'CAP_EXCEEDED'].includes(cur.state)) {
      console.log(`\n${cur.state}`);
      for (const e of cur.events) console.log(`  ${e.seq}. ${e.type}${e.data?.txHash ? '  ' + link(e.data.txHash) : ''}`);
      if (cur.state !== 'CREDITED') process.exit(1);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('payment did not reach a terminal state in 2 minutes');
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
