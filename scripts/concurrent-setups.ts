/**
 * Three sponsored sign-ups at the same moment, each on its own channel account, land in ONE ledger
 * (Unit 5 evidence). Stellar TESTNET only. Keypairs stand in for the wallet; nothing is mocked.
 *
 *   pnpm concurrent-setups                                   # the local stack
 *   ORCHESTRATOR_URL=https://api.corra.money pnpm concurrent-setups
 *
 * Three concurrent POST /setup for fresh accounts, each with a payment-account key; checks offline
 * that each user's two transactions share one channel as source (payment account first, the
 * account one sequence later) and that the three channels differ; submits the three payment-account
 * setups, then the three account setups, all at once. Passes when the three account setups share a
 * ledger; otherwise tries again with fresh keys (at most 3 attempts). Stops at the first 429.
 */
import * as S from '@stellar/stellar-sdk';
import { TESTNET, TESTNET_CHANNELS } from '../packages/shared/src';
import { assertPaymentAccountSetup, isPaymentAccount } from '../packages/stellar/src';
import { writeEvidence } from './lib/evidence';
import { horizon, NP, txLink } from './lib/pool';

const API = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8787';
const SP = TESTNET.feeSponsor;
const ATTEMPTS = 3;

type User = { p: S.Keypair; z: S.Keypair; pa: S.Transaction; own: S.Transaction };
type Landed = { hash: string; ledger: number };

function fail(message: string, code = 1): never {
  console.error(`FAIL ${message}`);
  process.exit(code);
}

async function setupOf(p: S.Keypair, z: S.Keypair): Promise<User> {
  const r = await fetch(`${API}/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: p.publicKey(), trust: ['MXN'], paymentAccount: z.publicKey() }),
  });
  if (r.status === 429) fail('rate limited by /setup: on production wait 10 minutes; on the local stack check CORRA_LOCAL_SETUP_LIMITS', 2);
  const json: any = await r.json();
  if (!r.ok || !json.xdr || !json.paymentAccountXdr) fail(`POST /setup -> ${r.status} ${JSON.stringify(json)}`);
  const parse = (x: string) => S.TransactionBuilder.fromXDR(x, NP) as S.Transaction;
  return { p, z, pa: parse(json.paymentAccountXdr), own: parse(json.xdr) };
}

/** The offline checks before anything is signed. */
function checkShapes(users: User[]) {
  const sources = users.map((u) => u.own.source);
  for (const u of users) {
    if (u.pa.source !== u.own.source) fail('a user\'s two setups have different sources');
    if (BigInt(u.own.sequence) !== BigInt(u.pa.sequence) + 1n) fail('the account setup is not the payment-account setup\'s next sequence');
    const types = u.own.operations.map((o) => o.type).join(',');
    if (types !== 'beginSponsoringFutureReserves,createAccount,changeTrust,endSponsoringFutureReserves') fail(`unexpected account setup: ${types}`);
    if (u.own.operations[0].source !== SP) fail('the sponsorship is not begun by the sponsor');
    assertPaymentAccountSetup(u.pa.toXDR(), u.p.publicKey(), u.z.publicKey(), NP, SP);
  }
  if (new Set(sources).size !== 3 || sources.some((s) => !TESTNET_CHANNELS.includes(s) || s === SP)) {
    fail(`fallback used (sources ${sources.join(', ')}): are the channels loaded (pnpm create-channels, then restart the orchestrator), or all leased (wait 315 s)?`);
  }
}

async function submitAll(txs: S.Transaction[]): Promise<Landed[]> {
  return Promise.all(txs.map(async (tx) => {
    try {
      const r = await horizon.submitTransaction(tx);
      return { hash: r.hash, ledger: r.ledger };
    } catch (e: any) {
      fail(`submit ${Buffer.from(tx.hash()).toString('hex')}: ${JSON.stringify(e?.response?.data?.extras?.result_codes ?? e?.message)}`);
    }
  }));
}

async function main() {
  console.log(`concurrent-setups against ${API} (Stellar TESTNET)`);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const keys = [0, 1, 2].map(() => ({ p: S.Keypair.random(), z: S.Keypair.random() }));
    const users = await Promise.all(keys.map((k) => setupOf(k.p, k.z)));
    checkShapes(users);
    for (const u of users) u.pa.sign(u.z);
    const a = await submitAll(users.map((u) => u.pa));
    for (const u of users) u.own.sign(u.p); // the wallet in the app
    const b = await submitAll(users.map((u) => u.own));
    const ledgers = b.map((x) => x.ledger);
    if (new Set(ledgers).size !== 1) {
      console.log(`attempt ${attempt}: account setups landed in ledgers ${ledgers.join(', ')}; trying again with fresh keys`);
      continue;
    }

    // Horizon: what landed is what was checked.
    for (const [i, u] of users.entries()) {
      const t = await horizon.transactions().transaction(b[i].hash).call();
      if (!t.successful || t.source_account !== u.own.source || t.fee_account !== u.own.source) fail(`account setup ${b[i].hash} is not sourced and paid by its channel`);
      const acct: any = await horizon.loadAccount(u.p.publicKey());
      const native = acct.balances.find((x: any) => x.asset_type === 'native');
      if (Number(native?.balance) !== 0 || acct.sponsor !== SP) fail(`${u.p.publicKey()} is not a 0-XLM account sponsored by the sponsor`);
      if (!acct.balances.some((x: any) => x.asset_code === 'TESTMXN' && x.asset_issuer === TESTNET.corridorIssuer)) fail(`${u.p.publicKey()} has no TESTMXN line`);
      if (!isPaymentAccount(await horizon.loadAccount(u.z.publicKey()) as any, u.p.publicKey(), SP)) fail(`${u.z.publicKey()} is not ${u.p.publicKey()}'s payment account`);
    }

    console.log(`PASS three sponsored setups in ledger ${ledgers[0]}, each from a different channel account`);
    console.log(`  payment-account setups landed in ledger(s) ${[...new Set(a.map((x) => x.ledger))].join(', ')}`);
    for (const [i, u] of users.entries()) {
      console.log(`  user ${i + 1} via channel ${u.own.source}`);
      console.log(`    payment account ${txLink(a[i].hash)}`);
      console.log(`    account         ${txLink(b[i].hash)}`);
    }
    writeEvidence('d3', 'concurrent-setups', {
      network: 'testnet', ledger: ledgers[0], attempts: attempt,
      users: users.map((u, i) => ({
        account: u.p.publicKey(), paymentAccount: u.z.publicKey(), channel: u.own.source,
        paymentAccountTx: a[i].hash, accountTx: b[i].hash, ledgers: { paymentAccount: a[i].ledger, account: b[i].ledger },
      })),
    }, API);
    return;
  }
  fail(`the account setups did not share a ledger in ${ATTEMPTS} attempts`);
}

main().catch((e) => fail((e as Error).message));
