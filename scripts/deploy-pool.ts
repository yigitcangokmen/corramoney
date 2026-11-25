/**
 * D2 Plan A: Corra's own TESTMXN lending pool on Stellar TESTNET, deployed through Blend's pool
 * factory, On-Ice (status 2: supply and withdraw on, borrowing off), reserve c_factor = l_factor = 0,
 * backstop take rate 0, max 2 positions. The oracle is Blend's unmodified mock-sep-40, deployed
 * from its on-chain WASM hash.
 *
 * Writes packages/shared/src/testnet-blend.ts (public ids) and an evidence JSON. All-or-nothing:
 * on a failure it prints the ids made so far and stops; a rerun starts fresh. It refuses to replace
 * a recorded pool that still verifies unless --redeploy. --redeploy also refuses while the recorded
 * pool still holds deposits (reserve bSupply > 0): the app and /pool/submit serve only the recorded
 * pool, so a 0-XLM user could not withdraw from the old one. --strand-deposits overrides that and
 * the evidence JSON records it.
 *
 * Usage: pnpm deploy-pool [--redeploy [--strand-deposits]]
 */
import * as S from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { PoolContractV2, PoolFactoryContractV2, ReserveConfigV2 } from '@blend-capital/blend-sdk';
import { TESTNET, TESTNET_BLEND, type BlendIds } from '../packages/shared/src';
import {
  blendUtils, call, check, contractLink, ensureAdminKey, ensureTtl, footprintTx, invoke, native, NP, ORACLE_WASM,
  otherAsset, read, RESERVE, rpc, sharedKeys, SOW_FACTORY, stellarAsset, suppliers, ttlOf, txLink, verifyPool, writeBlend, writeEvidence,
} from './lib/pool';
import { recordedPoolLives as poolLives } from './lib/reset';

const args = process.argv.slice(2);
const REDEPLOY = args.includes('--redeploy');
const STRAND = args.includes('--strand-deposits');
const SAC = TESTNET.sac.TESTMXN;
/** USD per TESTMXN, 7 decimals: 1 / 18.35. Supply and withdraw never read it. */
const TESTMXN_PRICE = 544_959n;

const made: Record<string, string> = {};
const steps: { label: string; hash: string; ledger: number }[] = [];

const u32 = (n: number) => S.nativeToScVal(n, { type: 'u32' });
const i128 = (n: bigint) => S.nativeToScVal(n, { type: 'i128' });

async function step(kp: S.Keypair, op: string | S.xdr.Operation, label: string) {
  const out = await invoke(kp, op, label);
  steps.push({ label, hash: out.hash, ledger: out.ledger });
  return out;
}

/**
 * A recorded pool that still answers as a factory pool with a config: rerunning would change the ids
 * the app uses. False only when its instance is gone (a reset) or the factory says it is not its pool;
 * a flaky read throws, so the refusal and the strand check below are never skipped (S5-1).
 */
const recordedPoolLives = (b: BlendIds) => poolLives({
  instanceLive: async () => (await rpc.getLedgerEntries(new S.Contract(b.pool).getFootprint())).entries.length > 0,
  isPool: () => native(call(b.factory, 'is_pool', new S.Address(b.pool).toScVal())),
  config: () => read(new PoolContractV2(b.pool).getConfig()),
});

/** --redeploy on a pool that still holds deposits strands them: refuse unless --strand-deposits. */
async function strandCheck(b: BlendIds) {
  const reserve = PoolContractV2.parsers.getReserve((await read(new PoolContractV2(b.pool).getReserve(b.asset))).toXDR('base64'));
  const bSupply = reserve.data.bSupply;
  if (bSupply <= 0n) return null;
  const accounts = await suppliers(b.pool);
  const msg = `the recorded pool ${b.pool} still holds bSupply ${bSupply} (${Number(bSupply) / 1e7} b-tokens of ${b.assetCode}); `
    + `a new pool strands it: the app and /pool/submit serve only the recorded pool, so a 0-XLM user could not withdraw. `
    + `Accounts with a SUCCESS supply: ${typeof accounts === 'string' ? accounts : accounts.join(', ') || 'none in pool_ops'}`;
  if (!STRAND) throw new Error(`${msg}. Pass --strand-deposits too to replace it anyway.`);
  console.log(`WARNING (--strand-deposits): ${msg}`);
  return { pool: b.pool, bSupply, accounts };
}

/** Oracle from Blend's WASM hash, then set_data; a set_data someone else made first means a new salt. */
async function deployOracle(admin: S.Keypair, wasm: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const out = await step(admin, S.Operation.createCustomContract({
      address: new S.Address(admin.publicKey()), wasmHash: Buffer.from(wasm, 'hex'), salt: randomBytes(32),
    }), `oracle deploy${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    const oracle = S.scValToNative(out.retval!) as string;
    made.oracle = oracle;
    try {
      await step(admin, call(oracle, 'set_data', new S.Address(admin.publicKey()).toScVal(), otherAsset('USD'),
        S.xdr.ScVal.scvVec([stellarAsset(SAC)]), u32(7), u32(300)), 'oracle set_data');
      const base = await native(call(oracle, 'base'));
      const assets = await native(call(oracle, 'assets'));
      const decimals = await native(call(oracle, 'decimals'));
      check(JSON.stringify(base) === JSON.stringify(['Other', 'USD']), `oracle base ${JSON.stringify(base)}`);
      check(JSON.stringify(assets) === JSON.stringify([['Stellar', SAC]]), `oracle assets ${JSON.stringify(assets)}`);
      check(decimals === 7, `oracle decimals ${decimals}`);
      return oracle;
    } catch (e) {
      if (attempt >= 2) throw e;
      console.log(`  oracle ${oracle} did not take our set_data (${(e as Error).message}); deploying another with a new salt`);
    }
  }
}

async function main() {
  console.log(`deploy-pool (Plan A) on ${NP}`);
  if (args.includes('--plan-b')) throw new Error('Plan B is written only on a Plan A NO-GO (spec section 10); Plan A is GO');

  // 0a. the admin key
  const admin = await ensureAdminKey();
  const team = [TESTNET.feeSponsor, TESTNET.corridorIssuer, TESTNET.usdcIssuer, TESTNET.anchorDistribution,
    TESTNET.marketMaker, TESTNET.clientDomainSigner];
  check(!team.includes(admin.publicKey() as any), 'the pool admin must not be the sponsor, an issuer or another team key');

  let stranded = null;
  if (TESTNET_BLEND && await recordedPoolLives(TESTNET_BLEND)) {
    if (!REDEPLOY) throw new Error(`TESTNET_BLEND already names a live pool ${TESTNET_BLEND.pool}; pass --redeploy to replace it`);
    stranded = await strandCheck(TESTNET_BLEND);
  }

  // 0b. Blend's testnet ids, and the oracle WASM hash it publishes (ORACLE_WASM is what we deployed before)
  const { ids, hashes } = await blendUtils();
  const oracleWasm = hashes.oraclemock ?? ORACLE_WASM;
  if (oracleWasm !== ORACLE_WASM) console.log(`WARNING: blend-utils oraclemock ${oracleWasm} differs from the expected ${ORACLE_WASM}; deploying blend-utils'`);
  const factory = ids.poolFactoryV2;
  const backstop = ids.backstopV2;
  if (factory !== SOW_FACTORY) console.log(`WARNING: blend-utils factory ${factory} differs from the SOW's ${SOW_FACTORY} (a testnet reset?)`);
  if (TESTNET_BLEND && factory !== TESTNET_BLEND.factory) console.log(`WARNING: factory ${factory} differs from the recorded ${TESTNET_BLEND.factory}`);
  console.log(`factory ${factory}\nbackstop ${backstop}\nTESTMXN SAC ${SAC}`);

  // 0c. preflight: everything the pool depends on exists (missing = a reset), archived code is restored
  const codeKey = S.xdr.LedgerKey.contractCode(new S.xdr.LedgerKeyContractCode({ hash: Buffer.from(oracleWasm, 'hex') }));
  const deps = [['factory', new S.Contract(factory).getFootprint()], ['backstop', new S.Contract(backstop).getFootprint()],
    ['TESTMXN SAC instance', new S.Contract(SAC).getFootprint()], ['oracle WASM', codeKey]] as const;
  const t = await ttlOf(deps.map(([, k]) => k));
  const missing = deps.filter((_d, i) => t.live[i] === 0).map(([n]) => n);
  if (missing.length) throw new Error(`missing on testnet: ${missing.join(', ')} (after a testnet reset Blend redeploys first)`);
  const archived = deps.filter((_d, i) => t.live[i] <= t.latest);
  if (archived.length) {
    console.log(`restoring archived: ${archived.map(([n]) => n).join(', ')}`);
    const out = await footprintTx(admin, archived.map(([, k]) => k), 'restore', 0);
    steps.push({ label: 'preflight restore', hash: out.hash, ledger: out.ledger });
  }
  check(await native(call(factory, 'is_pool', new S.Address(ids.TestnetV2).toScVal())) === true, 'factory.is_pool(TestnetV2)');

  // 1-3. oracle
  const oracle = await deployOracle(admin, oracleWasm);
  await step(admin, call(oracle, 'set_price_stable', S.xdr.ScVal.scvVec([i128(TESTMXN_PRICE)])), 'oracle set_price_stable');
  const price = (await native(call(oracle, 'lastprice', stellarAsset(SAC)))) as { price: bigint } | undefined;
  check(price?.price === TESTMXN_PRICE, `lastprice ${price?.price}`);

  // 4. pool
  const deployed = await step(admin, new PoolFactoryContractV2(factory).deployPool({
    admin: admin.publicKey(), name: 'Corra TESTMXN', salt: randomBytes(32), oracle,
    backstop_take_rate: 0, max_positions: 2, min_collateral: 0n,
  }), 'pool deploy');
  const pool = PoolFactoryContractV2.parsers.deployPool(deployed.retval!.toXDR('base64'));
  check(pool === S.scValToNative(deployed.retval!), 'deployPool result');
  made.pool = pool;
  check(await native(call(factory, 'is_pool', new S.Address(pool).toScVal())) === true, 'factory.is_pool(pool)');
  const p = new PoolContractV2(pool);
  check(PoolContractV2.parsers.getConfig((await read(p.getConfig())).toXDR('base64')).status === 6, 'new pool in Setup (6)');

  // 5. reserve: no timelock while in Setup
  const r = RESERVE;
  await step(admin, p.queueSetReserve({ asset: SAC, metadata: new ReserveConfigV2(r.index, r.decimals, r.c_factor, r.l_factor,
    r.util, r.max_util, r.r_base, r.r_one, r.r_two, r.r_three, r.reactivity, r.supply_cap, r.enabled) }), 'queue_set_reserve');
  await step(admin, p.setReserve(SAC), 'set_reserve');

  // 6. On-Ice, admin
  await step(admin, p.setStatus(2), 'set_status(2)');

  // 7. verify
  await verifyPool({ factory, pool, oracle, asset: SAC, admin: admin.publicKey() });

  // 8. TTL of every shared entry
  console.log('TTL of the pool, oracle and SAC entries:');
  const ttl = await ensureTtl(admin, await sharedKeys(pool, oracle, SAC));
  steps.push(...ttl.steps.map((s) => ({ ...s, label: `ttl ${s.label}` })));

  // 9. record
  const blend: BlendIds = {
    plan: 'A', factory, backstop, oracle, pool, asset: SAC, assetCode: 'TESTMXN', assetIssuer: TESTNET.corridorIssuer,
    admin: admin.publicKey(), deployedAt: new Date().toISOString(),
  };
  writeBlend(blend);
  const ledger = (await rpc.getLatestLedger()).sequence;
  writeEvidence('deploy-pool', { network: NP, ledger, ids: blend, reserve: RESERVE, oraclePrice: TESTMXN_PRICE, steps,
    oracleWasm, oracleWasmExpected: ORACLE_WASM, strandDeposits: STRAND, stranded });

  console.log(`\noracle ${contractLink(oracle)}\npool   ${contractLink(pool)}\nadmin  ${admin.publicKey()}`);
  for (const s of steps) console.log(`  ${s.label.padEnd(24)} ${txLink(s.hash)}`);
  console.log('\nDONE: run pnpm typecheck, then ORCHESTRATOR_URL=http://localhost:8787 pnpm pool-check');
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  if (Object.keys(made).length) console.error(`made so far (abandoned; a rerun starts fresh): ${JSON.stringify(made)}`);
  for (const s of steps) console.error(`  ${s.label}: ${s.hash}`);
  process.exit(1);
});
