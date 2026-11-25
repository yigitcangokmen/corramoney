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
 *
 * After CREDITED the payment's cash_out leg is PENDING: the recipient holds the TESTPHP.
 *
 *   ORCHESTRATOR_URL=http://localhost:8787 pnpm drive-payment --cash-out
 *
 * --cash-out (D3): the recipient also gets a payment account at setup, then cashes the TESTPHP out
 * at the anchor: SEP-10 with Corra's client_domain, SEP-24 withdraw, the confirm on the anchor's
 * page, one recipient-signed payment to the anchor's distribution account that Corra fee-bumps,
 * and the anchor's simulated payout. Proves a refused blob (amount + 1 stroop) and a replay too,
 * and writes evidence/2026-12/<phase>/d3/cash-out-<time>.json (public ids and hashes only) and the
 * anchor's completed more_info page as d3/more-info-<anchor id>.html, its token removed.
 */
import * as S from '@stellar/stellar-sdk';
import { PublicKeypair, Wallet } from '@stellar/typescript-wallet-sdk';
import { readFileSync } from 'node:fs';
import { cashInMemo, fiatAsset, moneyFromWire, parseUnits, roundUp, TESTNET, toDecimal } from '../packages/shared/src';
import { buildCashOutPayment, buildStrictReceive, type CashOutMemo } from '../packages/stellar/src';
import { EVIDENCE_ROOT, stripToken, writeEvidence, writeEvidenceText } from './lib/evidence';
import { setupViaCorra } from './lib/setup';

const API = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8787';
const CASH_OUT = process.argv.slice(2).includes('--cash-out');
const BUSINESS = process.env.ANCHOR_BUSINESS_URL ?? 'http://localhost:8091';
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
  const business = BUSINESS;
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

async function main() {
  const sender = S.Keypair.random();
  const recipient = S.Keypair.random();
  console.log(`orchestrator ${API}\nsender    ${sender.publicKey()}\nrecipient ${recipient.publicKey()}`);

  const s = await setupViaCorra(API, sender, ['MXN']);
  // A recipient that cashes out signs the withdrawal payment, so it needs a payment account too.
  const r = await setupViaCorra(API, recipient, ['PHP'], CASH_OUT);
  const z = s.paymentAccount!;
  console.log(`\nsetup (sponsored, 0 XLM)\n  sender's payment account ${z} ${link(s.paymentAccountHash!)}\n  sender    ${link(s.accountHash!)}\n  recipient ${link(r.accountHash!)}`);
  if (r.paymentAccount) console.log(`  recipient's payment account ${r.paymentAccount} ${link(r.paymentAccountHash!)}`);

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

  const acct = await horizon.loadAccount(z);
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: z, paymentSequence: acct.sequence, recipient: recipient.publicKey(),
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
  let credited: any = null;
  for (let i = 0; i < 60 && !credited; i++) {
    const cur = await api('GET', `/payments/${p.id}`);
    if (['CREDITED', 'EXPIRED', 'CAP_EXCEEDED'].includes(cur.state)) {
      console.log(`\n${cur.state}`);
      for (const e of cur.events) console.log(`  ${e.seq}. ${e.type}${e.data?.txHash ? '  ' + link(e.data.txHash) : ''}`);
      if (cur.state !== 'CREDITED') process.exit(1);
      credited = cur;
    } else {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!credited) throw new Error('payment did not reach a terminal state in 2 minutes');

  // CREDITED means the recipient holds the TESTPHP; the cash-out waits for the recipient.
  const leg = credited.legs.find((l: any) => l.kind === 'cash_out');
  if (!leg || leg.status !== 'PENDING' || !leg.anchorId || leg.externalRef) throw new Error(`cash_out leg is not PENDING: ${JSON.stringify(leg)}`);
  if (credited.events.at(-1)?.data?.payoutRef) throw new Error('the CREDITED event still carries a payoutRef');
  console.log(`  cash_out leg PENDING (${leg.amount.amount} ${leg.amount.asset}, anchor ${leg.anchorId}): the recipient holds it`);

  if (CASH_OUT) await cashOut(credited, recipient, r.paymentAccount!, q);
}

const poll = async <T>(what: string, ms: number, every: number, fn: () => Promise<T | null>): Promise<T> => {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((r) => setTimeout(r, every))) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`${what}: not within ${ms / 1000} s`);
};

async function xlmOf(account: string) {
  const a = await horizon.loadAccount(account);
  return Number(a.balances.find((b: any) => b.asset_type === 'native')?.balance ?? 0);
}

/** The recipient's cash-out at the anchor (D3). The keypair stands in for Freighter. */
async function cashOut(p: any, recipient: S.Keypair, z: string, q: any) {
  const php = fiatAsset('PHP');
  const dest = moneyFromWire(q.dest);
  console.log(`\nCASH-OUT ${p.publicId}: ${toDecimal(dest)} TESTPHP from ${recipient.publicKey()}`);
  const token = await anchorLogin(recipient);
  const sep24 = anchorClient().sep24();
  const w: any = await sep24.withdraw({ assetCode: 'TESTPHP', authToken: token, withdrawalAccount: recipient.publicKey(), extraFields: { amount: q.dest.amount } } as any);
  console.log(`  SEP-24 withdraw ${w.id}`);
  const c = await fetch(`${BUSINESS}/sep24/withdraw-confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: new URL(w.url).searchParams.get('token') }),
  });
  if (!c.ok) throw new Error(`withdraw-confirm -> ${c.status} ${await c.text()}`);
  const ready: any = await poll('anchor pending_user_transfer_start', 60_000, 2000, async () => {
    const t: any = await sep24.getTransactionBy({ authToken: token, id: w.id });
    if (t.status === 'error' || t.status === 'expired') throw new Error(`anchor ${t.status}: ${t.message}`);
    return t.status === 'pending_user_transfer_start' ? t : null;
  });
  if (ready.withdraw_anchor_account !== TESTNET.anchorDistribution) throw new Error(`anchor asks for ${ready.withdraw_anchor_account}`);
  if (parseUnits(String(ready.amount_in)) !== dest.raw) throw new Error(`anchor asks for ${ready.amount_in}, the payment delivered ${toDecimal(dest)}`);
  if (!ready.withdraw_memo || !['id', 'text', 'hash'].includes(ready.withdraw_memo_type)) throw new Error('anchor gave no memo');
  const memo: CashOutMemo = { type: ready.withdraw_memo_type, value: ready.withdraw_memo };
  console.log(`  anchor ready: pay ${ready.amount_in} TESTPHP to ${ready.withdraw_anchor_account}, memo ${memo.type} ${memo.value}`);

  const blob = async (amount = dest) => {
    const tx = buildCashOutPayment({
      networkPassphrase: NP, recipient: recipient.publicKey(), paymentAccount: z, paymentSequence: (await horizon.loadAccount(z)).sequence,
      destination: TESTNET.anchorDistribution, amount, memo, now: Math.floor(Date.now() / 1000),
    });
    tx.sign(recipient); // Freighter in the app: one prompt
    return tx.toXDR();
  };
  const submit = (signedXdr: string) => fetch(`${API}/payments/${p.id}/cash-out/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: w.id, signedXdr }),
  });
  const bad = await submit(await blob({ asset: php as any, raw: dest.raw + 1n }));
  const badBody: any = await bad.json();
  if (bad.status !== 422) throw new Error(`amount + 1 stroop -> ${bad.status} ${JSON.stringify(badBody)}`);
  console.log(`  refused: amount + 1 stroop -> 422 ${badBody.error.code} (${badBody.error.message})`);

  const signed = await blob();
  const first = await submit(signed);
  const sent: any = await first.json();
  if (first.status !== 200) throw new Error(`cash-out submit -> ${first.status} ${JSON.stringify(sent)}`);
  console.log(`  submitted: ${link(sent.txHash)} (ledger ${sent.ledger})`);
  const again: any = await (await submit(signed)).json();
  if (again.replay !== true || again.txHash !== sent.txHash) throw new Error(`replay -> ${JSON.stringify(again)}`);
  console.log('  same body again -> 200 replay: true');

  const done: any = await poll('cash_out leg CONFIRMED', 180_000, 3000, async () => {
    const cur = await api('GET', `/payments/${p.id}`);
    return cur.legs.find((l: any) => l.kind === 'cash_out')?.status === 'CONFIRMED' ? cur : null;
  });
  const anchorDone: any = await poll('anchor completed', 60_000, 2000, async () => {
    const t: any = await sep24.getTransactionBy({ authToken: token, id: w.id });
    return t.status === 'completed' ? t : null;
  });
  const moreInfo = await (await fetch(anchorDone.more_info_url)).text();
  if (!moreInfo.includes('completed')) throw new Error(`more_info page does not say completed: ${anchorDone.more_info_url}`);

  console.log(`\n${done.state}, cash_out ${done.legs.find((l: any) => l.kind === 'cash_out').status}`);
  for (const e of done.events) console.log(`  ${e.seq}. ${e.type}${e.data?.txHash ? '  ' + link(e.data.txHash) : ''}`);
  console.log(`  anchor ${anchorDone.status}, payout ${anchorDone.external_transaction_id}\n  anchor record ${stripToken(anchorDone.more_info_url)}`);

  const [rx, zx] = [await xlmOf(recipient.publicKey()), await xlmOf(z)];
  const rAcct = await horizon.loadAccount(recipient.publicKey());
  const left = rAcct.balances.find((b: any) => b.asset_code === php.code && b.asset_issuer === php.issuer) as any;
  if (rx !== 0 || zx !== 0) throw new Error(`XLM: recipient ${rx}, payment account ${zx}`);
  if (parseUnits(left?.balance ?? '0') !== 0n) throw new Error(`recipient still holds ${left?.balance} TESTPHP`);
  console.log(`  recipient and its payment account hold 0 XLM; recipient TESTPHP ${left.balance}`);

  const pick = (type: string) => done.events.find((e: any) => e.type === type)?.data ?? null;
  const page = writeEvidenceText('d3', `more-info-${w.id}.html`, moreInfo);
  // redact() strips every token query parameter, also inside the events' more_info URLs.
  writeEvidence('d3', 'cash-out', {
    network: NP, payment: { id: p.id, publicId: p.publicId }, recipient: recipient.publicKey(), paymentAccount: z,
    distribution: TESTNET.anchorDistribution, feeSponsor: TESTNET.feeSponsor, amount: toDecimal(dest), asset: `${php.code}:${php.issuer}`,
    anchor: { id: w.id, status: anchorDone.status, payout: anchorDone.external_transaction_id, stellarTxId: anchorDone.stellar_transaction_id,
      moreInfo: anchorDone.more_info_url },
    moreInfoHtml: page.slice(EVIDENCE_ROOT.length + 1),
    withdrawal: { envelope: sent.txHash, inner: pick('CASH_OUT_SUBMITTED')?.txHash, ledger: sent.ledger, memo },
    events: done.events.map((e: any) => ({ seq: e.seq, type: e.type, data: e.data ?? null })),
    refused: { amountPlusOneStroop: badBody.error.code }, replay: again.replay,
  }, API);
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
