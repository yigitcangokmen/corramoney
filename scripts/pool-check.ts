/**
 * D2 go/no-go on Stellar TESTNET: a fresh 0-XLM account, set up through Corra's sponsored /setup
 * (with its 0-XLM payment account) and funded with 50 TESTMXN, supplies 20 to Corra's pool and
 * withdraws it all, each time one keypair signature on a Blend `submit` whose transaction source
 * is the payment account and whose operation source is the user, that Corra validates, fee-bumps and sends (POST
 * /pool/submit). The keypair stands in for Freighter; the transactions come from the app's own
 * builder (apps/web/src/logic/blend.ts). Needs the orchestrator (pnpm local:up).
 *
 *   ORCHESTRATOR_URL=http://localhost:8787 pnpm pool-check [--verify-only] [--min-days 14]
 *
 * --verify-only checks the pool on chain only and writes d2/pool-verify-<time>.json.
 *
 * Writes packages/stellar/src/fixtures/pool-submit.live.json (the two signed blobs, for the
 * validator's PS-live test) and an evidence JSON (public ids and hashes only).
 * Budget per run: 1 /setup, 2 per-account and 6 per-IP pool tokens.
 */
import * as S from '@stellar/stellar-sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PoolContractV2 } from '@blend-capital/blend-sdk';
import { fiatAsset, TESTNET, TESTNET_BLEND } from '../packages/shared/src';
import { buildSubmit, readPool, type PoolCfg } from '../apps/web/src/logic/blend';
import {
  check, contractLink, envValue, hex, horizon, minDaysLeft, NP, rpc, sharedKeys, txLink, verifyPool, writeEvidence,
} from './lib/pool';
import { setupViaCorra } from './lib/setup';

const API = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8787';
const args = process.argv.slice(2);
const VERIFY_ONLY = args.includes('--verify-only');
const MIN_DAYS = Number(args[args.indexOf('--min-days') + 1] || 14) || 14;
const LIVE_FIXTURE = 'packages/stellar/src/fixtures/pool-submit.live.json';
const SUPPLY = 200_000_000n;
const FUND = '50.0000000';

async function call(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) as any };
}

const poolSubmit = (signedXdr: string, key: string = crypto.randomUUID()) =>
  call('POST', '/pool/submit', { signedXdr }, { 'idempotency-key': key });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RPC serves state a moment after Horizon: wait until it has ledger `seq`. */
async function rpcAt(seq: number) {
  for (let i = 0; i < 30 && (await rpc.getLatestLedger()).sequence < seq; i++) await sleep(1000);
}

async function balances(pk: string) {
  const a = await horizon.loadAccount(pk);
  const mxn = fiatAsset('MXN');
  const line: any = a.balances.find((b: any) => b.asset_code === mxn.code && b.asset_issuer === mxn.issuer);
  const xlm: any = a.balances.find((b: any) => b.asset_type === 'native');
  return { xlm: xlm.balance as string, mxn: line?.balance as string };
}

/** Submit a signed pool blob; on SUBMITTED poll the account's list for up to 60 s. */
async function submitAndLand(pk: string, signedXdr: string, label: string, key: string = crypto.randomUUID()) {
  const r = await poolSubmit(signedXdr, key);
  check(r.status === 201, `${label}: /pool/submit ${r.status} ${JSON.stringify(r.json)}`);
  let op = r.json;
  for (let i = 0; i < 20 && op.status === 'SUBMITTED'; i++) {
    await sleep(3000);
    op = (await call('GET', `/accounts/${pk}/pool-ops?limit=10`)).json.ops.find((o: any) => o.id === op.id) ?? op;
  }
  check(op.status === 'SUCCESS', `${label}: ${op.status} ${op.resultCode ?? ''}`);
  console.log(`  ${label}: SUCCESS in ledger ${op.ledger}, fee-bump ${txLink(op.txHash)} (inner ${op.innerHash})`);
  return op;
}

/** A signed blob Corra must refuse: built with blend-sdk on the payment account, simulated where the pool allows it, else given Soroban data by hand. */
async function refusalBlob(cfg: PoolCfg, user: S.Keypair, z: string, requests: { request_type: number; address: string; amount: bigint }[], to = user.publicKey()) {
  const pk = user.publicKey();
  const call = S.Operation.fromXDRObject(S.xdr.Operation.fromXDR(new PoolContractV2(cfg.poolId).submit({ from: pk, spender: pk, to, requests }), 'base64')) as S.Operation.InvokeHostFunction;
  const op = () => S.Operation.invokeHostFunction({ func: call.func, auth: call.auth, source: pk });
  const tx = new S.TransactionBuilder(await rpc.getAccount(z), { fee: '0', networkPassphrase: NP })
    .addOperation(op()).setTimebounds(0, Math.floor(Date.now() / 1000) + 300).build();
  const sim = await rpc.simulateTransaction(tx);
  const out = S.rpc.Api.isSimulationSuccess(sim)
    ? S.rpc.assembleTransaction(tx, sim).build()
    : new S.TransactionBuilder(await rpc.getAccount(z), { fee: '0', networkPassphrase: NP })
      .addOperation(op()).setTimebounds(0, Math.floor(Date.now() / 1000) + 300)
      .setSorobanData(new S.SorobanDataBuilder().setResourceFee('100000').build()).build();
  out.sign(user);
  return { xdr: out.toXDR(), simulated: S.rpc.Api.isSimulationSuccess(sim) };
}

async function refused(label: string, xdr: string, message: string) {
  const r = await poolSubmit(xdr);
  check(r.status === 422 && r.json.error?.code === 'REFUSED' && r.json.error?.message === message,
    `${label}: expected 422 "${message}", got ${r.status} ${JSON.stringify(r.json)}`);
  console.log(`  ${label}: 422 REFUSED "${message}"`);
  return { label, status: r.status, code: r.json.error.code, message };
}

async function main() {
  const b = TESTNET_BLEND;
  if (!b) throw new Error('no pool in packages/shared/src/testnet-blend.ts (run pnpm deploy-pool)');
  check(b.plan === 'A', 'this check is the Plan A go/no-go');
  const cfg: PoolCfg = { rpcUrl: TESTNET.rpcUrl, networkPassphrase: NP, poolId: b.pool, asset: b.asset };
  console.log(`pool-check against ${API}\npool ${contractLink(b.pool)}`);

  // 1. the pool is what we deployed, and stays alive long enough
  const verified = await verifyPool(b);
  const days = await minDaysLeft(await sharedKeys(b.pool, b.oracle, b.asset));
  check(days >= MIN_DAYS, `a shared pool entry archives in ${days.toFixed(1)} days (< ${MIN_DAYS}): run pnpm pool-ttl`);
  console.log(`TTL: every shared entry lives ${days.toFixed(1)}+ more days`);
  if (VERIFY_ONLY) {
    writeEvidence('pool-verify', {
      network: NP, ledger: (await rpc.getLatestLedger()).sequence, ids: b, status: verified.cfg.status,
      reserve: verified.reserve.config, admin: b.admin, minDaysLeft: Number(days.toFixed(1)),
    });
    console.log('\nVERIFIED (--verify-only): Plan A pool On-Ice, borrowing off, our admin and oracle');
    return;
  }
  const health = await call('GET', '/health');
  check(health.status === 200, `orchestrator at ${API} (pnpm local:up?)`);

  // 2. a fresh account through Corra's sponsored setup: 0 XLM
  const user = S.Keypair.random();
  const pk = user.publicKey();
  const setup = await setupViaCorra(API, user, ['MXN']);
  const z = setup.paymentAccount!;
  check(Number((await balances(pk)).xlm) === 0, 'the new account holds 0 XLM');
  console.log(`\nuser ${pk}\n  payment account ${z}: ${txLink(setup.paymentAccountHash!)}\n  setup (sponsored, 0 XLM): ${txLink(setup.accountHash!)}`);
  const setupRes = { hash: setup.accountHash! };

  // 3. 50 TESTMXN from the anchor's distribution account (team testnet key)
  const anchorSecret = envValue('ANCHOR_DISTRIBUTION_SECRET');
  if (!anchorSecret) throw new Error('ANCHOR_DISTRIBUTION_SECRET is not in .env.testnet');
  const anchor = S.Keypair.fromSecret(anchorSecret);
  const mxn = fiatAsset('MXN');
  const fundTx = new S.TransactionBuilder(await horizon.loadAccount(anchor.publicKey()), { fee: '1000', networkPassphrase: NP })
    .addOperation(S.Operation.payment({ destination: pk, asset: new S.Asset(mxn.code, mxn.issuer!), amount: FUND }))
    .setTimeout(60).build();
  fundTx.sign(anchor);
  const fundRes = await horizon.submitTransaction(fundTx);
  console.log(`  funded ${FUND} TESTMXN: ${txLink(fundRes.hash)}`);
  await rpcAt(fundRes.ledger);

  // 4. supply 20: the app's builder, one keypair signature, Corra fee-bumps
  const supplyNow = Math.floor(Date.now() / 1000);
  const supplyBuilt = await buildSubmit(cfg, pk, z, (await horizon.loadAccount(z)).sequence, 'supply', SUPPLY, supplyNow);
  const supplyTx = S.TransactionBuilder.fromXDR(supplyBuilt.xdr, NP) as S.Transaction;
  supplyTx.sign(user);
  const supplyXdr = supplyTx.toXDR();
  console.log(`  supply 20 TESTMXN, resource fee ${supplyBuilt.resourceFee} stroops, inclusion 0`);
  const supplyKey = crypto.randomUUID();
  const supply = await submitAndLand(pk, supplyXdr, 'supply', supplyKey);
  check(supply.innerHash === hex(supplyTx.hash()), 'the row names our inner hash');

  // 5. on chain: the sponsor's fee-bump around the user's own signature; the user still holds 0 XLM
  const h: any = await horizon.transactions().transaction(supply.innerHash).call();
  check(h.fee_account === TESTNET.feeSponsor, `fee account ${h.fee_account}`);
  check(h.fee_bump_transaction?.signatures?.length === 1, 'the outer envelope has one signature (the sponsor)');
  check(h.inner_transaction?.signatures?.length === 1, 'the inner transaction has one signature (the user)');
  check(h.source_account === z, `inner source ${h.source_account}, expected the payment account ${z}`);
  const supplyOp: any = (await horizon.operations().forTransaction(supply.innerHash).call()).records[0];
  check(supplyOp.source_account === pk, `operation source ${supplyOp.source_account}, expected the user`);
  check(BigInt(h.inner_transaction.max_fee) === supplyBuilt.resourceFee, `inner max_fee ${h.inner_transaction.max_fee} = resource fee (inclusion 0)`);
  check(Number((await balances(pk)).xlm) === 0, 'the user still holds 0 XLM');
  check(Number((await balances(z)).xlm) === 0, 'the payment account holds 0 XLM');
  console.log(`  Horizon: fee account ${h.fee_account} (Corra), outer 1 signature, inner 1 signature by the user, tx source = payment account, op source = user, fee_charged ${h.fee_charged}`);

  // 6. the position
  const afterSupply = await readPool(cfg, pk);
  check(afterSupply.underlyingRaw === SUPPLY, `position ${afterSupply.underlyingRaw}, expected ${SUPPLY}`);
  check(afterSupply.supplyApr === 0, `supply APR ${afterSupply.supplyApr}, expected 0 (On-Ice, no borrowing)`);
  console.log(`  position 20.0000000 TESTMXN (${afterSupply.bTokens} bTokens), APR 0.00%, status ${afterSupply.status}`);

  // 7. what the server refuses or replays (nothing reaches the chain)
  const refusals: object[] = [];
  const replay = await poolSubmit(supplyXdr, supplyKey);
  check(replay.status === 200 && replay.json.id === supply.id, `replay: ${replay.status} ${JSON.stringify(replay.json)}`);
  console.log('  same key, same blob: 200, the same row');
  refusals.push({ label: 'replay', status: 200, id: replay.json.id });
  const dup = await poolSubmit(supplyXdr);
  check(dup.status === 409 && dup.json.error?.code === 'DUPLICATE_TRANSACTION', `duplicate: ${dup.status} ${JSON.stringify(dup.json)}`);
  console.log('  new key, same blob: 409 DUPLICATE_TRANSACTION');
  refusals.push({ label: 'duplicate', status: 409, code: 'DUPLICATE_TRANSACTION' });
  const req = (request_type: number, amount = 10_000_000n) => ({ request_type, address: b.asset, amount });
  refusals.push(await refused('request type 2 (supply collateral)', (await refusalBlob(cfg, user, z, [req(2)])).xdr, 'only supply or withdraw'));
  refusals.push(await refused('to = another account', (await refusalBlob(cfg, user, z, [req(0)], TESTNET.demoRecipient)).xdr,
    'from, spender and to must be the signer'));
  refusals.push(await refused('two requests', (await refusalBlob(cfg, user, z, [req(0), req(0)])).xdr, 'exactly one request'));

  // 8. withdraw all: 1.01 x the position, the pool clamps
  const all = (afterSupply.underlyingRaw * 101n + 99n) / 100n;
  const withdrawNow = Math.floor(Date.now() / 1000);
  const withdrawBuilt = await buildSubmit(cfg, pk, z, (await horizon.loadAccount(z)).sequence, 'withdraw', all, withdrawNow);
  const withdrawTx = S.TransactionBuilder.fromXDR(withdrawBuilt.xdr, NP) as S.Transaction;
  withdrawTx.sign(user);
  const withdrawXdr = withdrawTx.toXDR();
  console.log(`  withdraw all (asks ${all}, the pool clamps), resource fee ${withdrawBuilt.resourceFee} stroops`);
  const withdraw = await submitAndLand(pk, withdrawXdr, 'withdraw');
  const afterWithdraw = await readPool(cfg, pk);
  check(afterWithdraw.bTokens === 0n, `bTokens ${afterWithdraw.bTokens} after withdraw all`);
  const end = await balances(pk);
  check(end.mxn === FUND, `TESTMXN ${end.mxn}, expected ${FUND}`);
  check(Number(end.xlm) === 0, 'the user still holds 0 XLM');
  check(Number((await balances(z)).xlm) === 0, 'the payment account still holds 0 XLM');
  console.log(`  position 0, TESTMXN back to ${end.mxn}, XLM ${end.xlm}`);

  // 9. Corra's record
  const list = (await call('GET', `/accounts/${pk}/pool-ops`)).json.ops;
  check(list.length === 2 && list[0].id === withdraw.id && list[1].id === supply.id && list.every((o: any) => o.status === 'SUCCESS'),
    `pool-ops list ${JSON.stringify(list.map((o: any) => [o.kind, o.status]))}`);
  console.log('  GET /accounts/:user/pool-ops: withdraw, supply, both SUCCESS');

  // 10. record
  mkdirSync('packages/stellar/src/fixtures', { recursive: true });
  writeFileSync(LIVE_FIXTURE, JSON.stringify({
    poolId: b.pool, asset: b.asset, source: pk, paymentAccount: z, sponsor: TESTNET.feeSponsor,
    supply: { xdr: supplyXdr, nowSec: supplyNow }, withdraw: { xdr: withdrawXdr, nowSec: withdrawNow },
  }, null, 2) + '\n');
  console.log(`wrote ${LIVE_FIXTURE}`);
  const wd: any = await horizon.transactions().transaction(withdraw.innerHash).call();
  writeEvidence('pool-check', {
    network: NP, pool: b.pool, asset: b.asset, account: pk, paymentAccount: z, paymentAccountSetup: setup.paymentAccountHash, setup: setupRes.hash, funding: fundRes.hash,
    supply: { outer: supply.txHash, inner: supply.innerHash, ledger: supply.ledger, resourceFee: supplyBuilt.resourceFee, fee_charged: h.fee_charged },
    withdraw: { outer: withdraw.txHash, inner: withdraw.innerHash, ledger: withdraw.ledger, resourceFee: withdrawBuilt.resourceFee, fee_charged: wd.fee_charged },
    refusals,
  });
  console.log(`\nsupply   ${txLink(supply.txHash)}\nwithdraw ${txLink(withdraw.txHash)}`);
  console.log('\nGO: Plan A pool supply and withdraw fee-bumped by Corra from a 0-XLM account');
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
