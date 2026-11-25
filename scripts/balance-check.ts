/**
 * D1 end to end on testnet: an unbound deposit, then payments from the sender's balance.
 * Keypairs stand in for Freighter. Needs the orchestrator (:8787), and for DEPOSIT=anchor the
 * anchor stack (infra/anchor).
 *
 *   ORCHESTRATOR_URL=http://localhost:8787 pnpm balance-check
 *
 * Deposit (DEPOSIT):
 *   anchor (default)  SEP-10 with Corra's client_domain, SEP-24 deposit with the deposit's memo and
 *                     no quote_id, linked to the deposit, simulated SPEI. Expects matchedBy 'ref'.
 *                     LINK=skip never links it: the signed callback's transaction finds it ('callback_tx').
 *   direct            the anchor distribution account pays with the memo; no link, no callback.
 *                     Expects 'chain', then a late link.
 * SENDS: comma-separated destination currencies, default PHP,BRL,ARS,IDR,THB.
 *
 * Writes evidence/2026-12/<phase>/d1/balance-check-<time>.json (public ids and hashes only).
 */
import * as S from '@stellar/stellar-sdk';
import { PublicKeypair, Wallet } from '@stellar/typescript-wallet-sdk';
import { readFileSync } from 'node:fs';
import { FIAT, fiatAsset, moneyFromWire, TESTNET, type FiatCode } from '../packages/shared/src';
import { buildStrictReceive } from '../packages/stellar/src';
import { stripToken, writeEvidence } from './lib/evidence';
import { setupViaCorra } from './lib/setup';

const API = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8787';
const NP = TESTNET.networkPassphrase;
const horizon = new S.Horizon.Server(TESTNET.horizonUrl);
const link = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const RECIPIENT = process.env.RECIPIENT ?? TESTNET.demoRecipient;
const DEPOSIT = process.env.DEPOSIT ?? 'anchor';
const LINK = process.env.LINK ?? 'link';
const DEPOSIT_AMOUNT = '2000.00';
/** Fixed destination amounts: together about 712 TESTMXN at today's books, inside one 2,000 deposit. */
const AMOUNTS: Partial<Record<FiatCode, string>> = { PHP: '500', BRL: '50', ARS: '5000', IDR: '100000', THB: '300' };
const SENDS = (process.env.SENDS ?? 'PHP,BRL,ARS,IDR,THB').split(',') as FiatCode[];

const env = Object.fromEntries(
  readFileSync('.env.testnet', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

async function call(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

async function api(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
  const { status, json } = await call(method, path, body, headers);
  if (status >= 400) throw new Error(`${method} ${path} -> ${status} ${JSON.stringify(json)}`);
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

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`check failed: ${what}`);
}

async function deposit(sender: S.Keypair) {
  const d = await api('POST', '/deposits', { account: sender.publicKey(), amount: DEPOSIT_AMOUNT });
  console.log(`\ndeposit ${d.id} PENDING, memo ${d.memo}`);
  if (DEPOSIT === 'direct') {
    const anchor = S.Keypair.fromSecret(env.ANCHOR_DISTRIBUTION_SECRET);
    const mxn = fiatAsset('MXN');
    const tx = new S.TransactionBuilder(await horizon.loadAccount(anchor.publicKey()), { fee: '1000', networkPassphrase: NP })
      .addOperation(S.Operation.payment({ destination: sender.publicKey(), asset: new S.Asset(mxn.code, mxn.issuer), amount: DEPOSIT_AMOUNT }))
      .addMemo(S.Memo.hash(Buffer.from(d.memo, 'base64')))
      .setTimeout(60).build();
    tx.sign(anchor);
    console.log(`  direct credit, no link, no callback ${link((await horizon.submitTransaction(tx)).hash)}`);
  } else {
    const token = await anchorLogin(sender);
    const dep = await anchorClient().sep24().deposit({
      assetCode: 'TESTMXN', authToken: token,
      extraFields: { amount: DEPOSIT_AMOUNT, memo: d.memo, memo_type: 'hash' },
    });
    console.log(`  SEP-24 deposit ${dep.id} at ${ANCHOR_DOMAIN}, no quote_id`);
    if (LINK !== 'skip') {
      await api('POST', `/deposits/${d.id}/link`, { ref: dep.id });
      console.log('  linked to the deposit');
    } else {
      console.log('  never linked: the signed callback must find it');
    }
    const business = process.env.ANCHOR_BUSINESS_URL ?? 'http://localhost:8091';
    const r = await fetch(`${business}/sep24/simulate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: new URL(dep.url!).searchParams.get('token'), amount: DEPOSIT_AMOUNT }),
    });
    const sim = await r.json();
    if (!r.ok) throw new Error(`simulate -> ${r.status} ${JSON.stringify(sim)}`);
    console.log(`  simulated SPEI, anchor paid ${link(sim.stellar_transaction_id)}`);
  }

  const expected = DEPOSIT === 'direct' ? 'chain' : LINK === 'skip' ? 'callback_tx' : 'ref';
  for (let i = 0; i < 60; i++) {
    const cur = await api('GET', `/deposits/${d.id}`);
    if (cur.status === 'CONFIRMED') {
      console.log(`  CONFIRMED by ${cur.matchedBy}, credited ${cur.credited.amount} ${link(cur.txHash)}`);
      console.log(`  anchorRef ${cur.anchorRef}, moreInfoUrl ${stripToken(String(cur.moreInfoUrl))}`);
      check(cur.matchedBy === expected, `matchedBy ${cur.matchedBy}, expected ${expected}`);
      check(cur.credited.amount === '2000.0000000', `credited ${cur.credited.amount}`);
      if (DEPOSIT === 'direct') {
        const late = await api('POST', `/deposits/${d.id}/link`, { ref: `direct-${d.id}` });
        check(late.status === 'CONFIRMED' && late.anchorRef === `direct-${d.id}`, 'late link on a CONFIRMED deposit');
        console.log(`  late link ok: anchorRef ${late.anchorRef}`);
      }
      return cur;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('deposit was not CONFIRMED within 3 minutes');
}

async function quote(f: FiatCode) {
  const dest = fiatAsset(f);
  return api('POST', '/quote', {
    corridor: { from: 'MX/MXN', to: `${FIAT[f].country}/${f}` },
    destAmount: { amount: AMOUNTS[f], asset: dest.code, issuer: dest.issuer },
  });
}

/** The /send body for `q`: the payment account's transaction at `sequence`, paid and signed by the sender. */
function signedSend(sender: S.Keypair, z: string, q: any, sequence: string, ttlSec?: number) {
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: z, paymentSequence: sequence, recipient: RECIPIENT,
    dest: moneyFromWire(q.dest), sendMax: moneyFromWire(q.maxSend), path: q.path, now: Math.floor(Date.now() / 1000),
    mode: 'balance', ttlSec,
  });
  tx.sign(sender);
  return { quoteId: q.id, sender: sender.publicKey(), recipient: RECIPIENT, signedXdr: tx.toXDR() };
}

const postSend = (body: object) => call('POST', '/send', body, { 'idempotency-key': crypto.randomUUID() });
const staleSequence = (r: { status: number; json: any }) =>
  r.status === 422 && r.json.error?.code === 'UNBOUND_TRANSACTION' && /payment account's next/.test(r.json.error?.message ?? '');

/**
 * Quote, build the payment account's next transaction, sign, POST /send. A lagging Horizon replica can
 * report a stale sequence right after the previous payment landed: on that 422, reload and re-sign.
 * With `pair`, a second blob (another quote, the same sequence) is built and signed up front and
 * posted right after a 201, with nothing in between, so the first cannot settle before it.
 */
async function sendOnce(sender: S.Keypair, z: string, f: FiatCode, pair = false) {
  const q = await quote(f);
  const q2 = pair ? await quote(f) : null;
  for (let attempt = 0; ; attempt++) {
    const { sequence } = await horizon.loadAccount(z);
    const body = signedSend(sender, z, q, sequence);
    const body2 = q2 ? signedSend(sender, z, q2, sequence, 299) : null;
    const r = await postSend(body);
    const second = body2 && r.status === 201 ? await postSend(body2) : null;
    if (!staleSequence(r) || attempt >= 2) return { q, ...r, second };
    console.log(`  stale sequence ${sequence} (lagging Horizon), retrying in 2 s`);
    await new Promise((res) => setTimeout(res, 2000));
  }
}

async function settled(id: string) {
  for (let i = 0; i < 60; i++) {
    const cur = await api('GET', `/payments/${id}`);
    if (['CREDITED', 'EXPIRED', 'CAP_EXCEEDED', 'FAILED'].includes(cur.state)) return cur;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`payment ${id} did not reach a terminal state in 2 minutes`);
}

async function main() {
  const sender = S.Keypair.random();
  console.log(`orchestrator ${API}\nsender    ${sender.publicKey()}\nrecipient ${RECIPIENT}\nDEPOSIT=${DEPOSIT} LINK=${LINK} SENDS=${SENDS.join(',')}`);
  const s = await setupViaCorra(API, sender, ['MXN']);
  const z = s.paymentAccount!;
  console.log(`\nsetup (sponsored, 0 XLM) ${link(s.accountHash!)}\npayment account ${z} ${link(s.paymentAccountHash!)}`);

  const d = await deposit(sender);
  const hashes: string[] = [];
  const sends: object[] = [];
  let inProgressProbe: object | null = null;
  for (const [i, f] of SENDS.entries()) {
    // Back to back, a different blob at the same sequence: one balance payment in flight per sender.
    const first = await sendOnce(sender, z, f, i === 1);
    check(first.status === 201 && first.json.state === 'CASH_IN' && first.json.kind === 'balance', `send ${f}: ${first.status} ${JSON.stringify(first.json)}`);
    console.log(`\n${f} ${first.json.publicId}: up to ${first.q.maxSend.amount} TESTMXN for ${first.q.dest.amount} ${first.q.dest.asset}, 201 CASH_IN`);
    const second = first.second;
    if (second) {
      check(second.status === 409 && second.json.error?.code === 'PAYMENT_IN_PROGRESS', `second send: ${second.status} ${JSON.stringify(second.json)}`);
      console.log('  a second send right after: 409 PAYMENT_IN_PROGRESS');
      inProgressProbe = { status: second.status, code: second.json.error.code };
    }
    const done = await settled(first.json.id);
    const last = done.events.at(-1);
    check(done.state === 'CREDITED', `${f} ended ${done.state} ${JSON.stringify(last?.data)}`);
    console.log(`  CREDITED in ledger ${last.data.ledger} ${link(last.data.txHash)}`);
    hashes.push(last.data.txHash);
    sends.push({ fiat: f, paymentId: done.id, publicId: done.publicId, txHash: last.data.txHash, ledger: last.data.ledger, state: done.state,
      dest: `${first.q.dest.amount} ${first.q.dest.asset}` });
  }

  const payments = (await api('GET', `/accounts/${sender.publicKey()}/payments`)).payments;
  check(payments.length === SENDS.length && payments.every((p: any) => p.kind === 'balance' && p.state === 'CREDITED'), 'payments list');
  check(payments.every((p: any, i: number) => i === 0 || payments[i - 1].createdAt >= p.createdAt), 'payments newest first');
  const deposits = (await api('GET', `/accounts/${sender.publicKey()}/deposits`)).deposits;
  check(deposits.length === 1 && deposits[0].id === d.id && deposits[0].status === 'CONFIRMED', 'deposits list');
  console.log(`\nlists ok: ${payments.length} balance payments, 1 deposit CONFIRMED`);
  console.log(`deposit ${d.txHash}\npayments ${hashes.join(' ')}`);
  writeEvidence('d1', 'balance-check', {
    sender: sender.publicKey(), paymentAccount: z, recipient: RECIPIENT, deposit: DEPOSIT,
    setup: { account: s.accountHash, paymentAccount: s.paymentAccountHash },
    depositRow: { id: d.id, status: d.status, matchedBy: d.matchedBy, anchorRef: d.anchorRef, txHash: d.txHash, credited: d.credited?.amount ?? null },
    sends, inProgressProbe,
  }, API);
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
