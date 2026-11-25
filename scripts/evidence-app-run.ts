/**
 * Captures what a Freighter run in the app did, from the orchestrator's public read routes only, so
 * no hash is ever copied by hand: the account's CONFIRMED deposits, its CREDITED payments (with the
 * on-chain hash and ledger), its SUCCESS pool ops and, with --recipient, the recipient's cash-outs.
 * Stellar TESTNET only. Public ids and hashes only.
 *
 *   ORCHESTRATOR_URL=https://api.corra.money EVIDENCE_PHASE=pre-reset pnpm evidence-app-run --account G... [--recipient G...] [--via-app]
 *
 * --via-app: the builder did this run in the app on https://app.corra.money (Freighter), not with a
 * script; only such a run on production is D1.hosted evidence (S3-3).
 *
 * Writes evidence/2026-12/<phase>/app/app-run-<first 8 of account>-<time>.json. Exit 1 "nothing to
 * capture" when the account has no CONFIRMED deposit and no CREDITED payment.
 */
import { writeEvidence } from './lib/evidence';

const API = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8787';
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ACCOUNT = opt('--account');
const RECIPIENT = opt('--recipient');
const VIA_APP = args.includes('--via-app');
const G = /^G[A-Z2-7]{55}$/;
/** readPerIp is 60 a minute: past this many detail reads, one a second. */
const FREE_READS = 40;

function fail(message: string): never {
  console.error(`evidence-app-run: ${message}`);
  process.exit(1);
}

let reads = 0;
async function get(path: string): Promise<{ status: number; json: any }> {
  if (++reads > FREE_READS) await new Promise((r) => setTimeout(r, 1000));
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(20_000) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function must(path: string) {
  const r = await get(path);
  if (r.status !== 200) fail(`GET ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const event = (p: any, type: string) => p.events?.find((e: any) => e.type === type)?.data ?? null;

async function main() {
  if (!ACCOUNT || !G.test(ACCOUNT)) fail('--account G... is required');
  if (RECIPIENT !== undefined && !G.test(RECIPIENT)) fail('--recipient must be a G... account');
  console.log(`evidence-app-run against ${API}\naccount ${ACCOUNT}${RECIPIENT ? `\nrecipient ${RECIPIENT}` : ''}`);

  const deposits = (await must(`/accounts/${ACCOUNT}/deposits?limit=100`)).deposits
    .filter((d: any) => d.status === 'CONFIRMED')
    .map((d: any) => ({ id: d.id, status: d.status, matchedBy: d.matchedBy, anchorRef: d.anchorRef, txHash: d.txHash, credited: d.credited?.amount ?? null }));

  const payments: object[] = [];
  for (const p of (await must(`/accounts/${ACCOUNT}/payments?role=sender&limit=100`)).payments) {
    if (p.state !== 'CREDITED') continue;
    const full = await must(`/payments/${p.id}`);
    const onchain = event(full, 'ONCHAIN') ?? event(full, 'CREDITED');
    payments.push({
      id: full.id, publicId: full.publicId, kind: full.kind, state: full.state, recipient: full.recipientAccount,
      destAsset: full.quote.dest.asset, destAmount: full.quote.dest.amount, txHash: onchain?.txHash ?? null, ledger: onchain?.ledger ?? null,
    });
  }

  const poolRes = await get(`/accounts/${ACCOUNT}/pool-ops?limit=100`);
  if (poolRes.status !== 200 && poolRes.status !== 503) fail(`GET pool-ops -> ${poolRes.status} ${JSON.stringify(poolRes.json)}`);
  const pool = poolRes.status === 503 ? null : {
    ops: poolRes.json.ops.filter((o: any) => o.status === 'SUCCESS')
      .map((o: any) => ({ id: o.id, kind: o.kind, status: o.status, pool: o.poolId, amount: o.amount.amount, txHash: o.txHash, innerHash: o.innerHash, ledger: o.ledger })),
  };

  const cashOuts: object[] = [];
  if (RECIPIENT) {
    for (const p of (await must(`/accounts/${RECIPIENT}/payments?role=recipient&limit=100`)).payments) {
      const leg = p.legs.find((l: any) => l.kind === 'cash_out');
      if (!leg || leg.status === 'FAILED' || !leg.txHash) continue;
      const full = await must(`/payments/${p.id}`);
      const onchain = event(full, 'CASH_OUT_ONCHAIN');
      cashOuts.push({
        paymentId: full.id, publicId: full.publicId, state: full.state, status: leg.status, anchorRef: leg.externalRef ?? null,
        amount: `${leg.amount.amount} ${leg.amount.asset}`, txHash: onchain?.txHash ?? null, inner: event(full, 'CASH_OUT_SUBMITTED')?.txHash ?? null,
        ledger: onchain?.ledger ?? null,
      });
    }
  }

  if (!deposits.length && !payments.length) fail('nothing to capture (no CONFIRMED deposit and no CREDITED payment)');
  console.log(`${deposits.length} confirmed deposit(s), ${payments.length} credited payment(s), ${pool ? pool.ops.length : 'no'} pool op(s), ${cashOuts.length} cash-out(s)`);
  writeEvidence('app', `app-run-${ACCOUNT.slice(0, 8)}`, { account: ACCOUNT, recipient: RECIPIENT ?? null, viaApp: VIA_APP, deposits, payments, pool, cashOuts }, API);
}

main().catch((e) => fail((e as Error).message));
