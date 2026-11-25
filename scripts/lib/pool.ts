/**
 * Admin-side Blend helpers for deploy-pool, pool-ttl and pool-check. Stellar TESTNET only.
 * The pool admin key (POOL_ADMIN_SECRET) lives in .env.testnet and is used here only: no
 * service loads it. Every admin transaction is admin-sourced and admin-paid, never fee-bumped.
 * No secret is ever printed.
 */
import * as S from '@stellar/stellar-sdk';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PoolContractV2 } from '@blend-capital/blend-sdk';
import { TESTNET, type BlendIds } from '../../packages/shared/src';
import { failureCode } from '../../packages/stellar/src';
import { writeEvidence as writeRun } from './evidence';

export const NP = TESTNET.networkPassphrase;
export const rpc = new S.rpc.Server(TESTNET.rpcUrl);
export const horizon = new S.Horizon.Server(TESTNET.horizonUrl);
export const BLEND_UTILS_URL = 'https://raw.githubusercontent.com/blend-capital/blend-utils/main/testnet.contracts.json';
/** Blend's own mock-sep-40 oracle WASM (blend-utils `hashes.oraclemock`); we deploy it unmodified. */
export const ORACLE_WASM = '66c0b87b5eb481be594175d59e66ec9a9ac8945be0fec4e09f6c28bf7a1708be';
export const SOW_FACTORY = 'CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6';
const ENV_PATH = '.env.testnet';
const BLEND_TS = 'packages/shared/src/testnet-blend.ts';

export const txLink = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
export const contractLink = (c: string) => `https://stellar.expert/explorer/testnet/contract/${c}`;
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** One value from .env.testnet; never printed. */
export function envValue(name: string): string | undefined {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim() || undefined;
  }
  return undefined;
}

export function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`check failed: ${what}`);
}

export async function friendbot(pk: string) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(pk)}`,
      { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (r?.ok) return;
    if (r?.status === 400 && /already funded|createAccountAlreadyExist/i.test(await r.text().catch(() => ''))) return;
    if (attempt >= 4) throw new Error(`friendbot ${r?.status ?? 'unreachable'} for ${pk}`);
    await new Promise((done) => setTimeout(done, 2000 * attempt));
  }
}

/** The account, friendbot-funding it first when it does not exist (a new key, or a testnet reset). */
export async function loadOrFund(pk: string) {
  try {
    return await horizon.loadAccount(pk);
  } catch (e: any) {
    if (e?.response?.status !== 404) throw e;
  }
  await friendbot(pk);
  console.log(`funded ${pk} (friendbot)`);
  return horizon.loadAccount(pk);
}

/**
 * The pool admin: from POOL_ADMIN_SECRET (friendbot-funded again when a testnet reset removed it),
 * or a new friendbot-funded key appended to .env.testnet.
 */
export async function ensureAdminKey(): Promise<S.Keypair> {
  const secret = envValue('POOL_ADMIN_SECRET');
  if (secret) {
    const kp = S.Keypair.fromSecret(secret);
    await loadOrFund(kp.publicKey());
    console.log(`pool admin ${kp.publicKey()} (POOL_ADMIN_SECRET in ${ENV_PATH})`);
    return kp;
  }
  const kp = S.Keypair.random();
  await friendbot(kp.publicKey());
  const text = readFileSync(ENV_PATH, 'utf8');
  appendFileSync(ENV_PATH, `${text.endsWith('\n') ? '' : '\n'}POOL_ADMIN_SECRET=${kp.secret()}\n`);
  console.log(`pool admin ${kp.publicKey()} (new, friendbot-funded, POOL_ADMIN_SECRET appended to ${ENV_PATH})`);
  return kp;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends a prepared, signed transaction and waits up to 60 s for it to land. Throws on ERROR or FAILED. */
export async function sendAndWait(tx: S.Transaction | S.FeeBumpTransaction, label: string) {
  const sent = await rpc.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`${label}: ${sent.errorResult ? failureCode(sent.errorResult.toXDR('base64')) : 'error'}`);
  if (sent.status === 'TRY_AGAIN_LATER') throw new Error(`${label}: try_again_later`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const r = await rpc.getTransaction(sent.hash);
    if (r.status === 'SUCCESS') return { hash: sent.hash, ledger: r.ledger, retval: r.returnValue };
    if (r.status === 'FAILED') throw new Error(`${label} failed in ledger ${r.ledger}: ${failureCode(r.resultXdr.toXDR('base64'))} ${txLink(sent.hash)}`);
  }
  throw new Error(`${label}: not landed within 60 s (${sent.hash})`);
}

/** One admin-signed Soroban call: simulate (prepareTransaction), sign, send, wait. */
export async function invoke(kp: S.Keypair, op: string | S.xdr.Operation, label: string) {
  const account = await rpc.getAccount(kp.publicKey());
  const operation = typeof op === 'string' ? S.xdr.Operation.fromXDR(op, 'base64') : op;
  const built = new S.TransactionBuilder(account, { fee: '10000', networkPassphrase: NP })
    .addOperation(operation).setTimeout(120).build();
  const tx = await rpc.prepareTransaction(built);
  tx.sign(kp);
  const out = await sendAndWait(tx, label);
  console.log(`  ${label}: ${out.hash} (ledger ${out.ledger})`);
  return out;
}

/** Simulates a read-only call. The source only has to be a valid G address. */
export async function simulate(op: string | S.xdr.Operation) {
  const operation = typeof op === 'string' ? S.xdr.Operation.fromXDR(op, 'base64') : op;
  const tx = new S.TransactionBuilder(new S.Account(TESTNET.feeSponsor, '0'), { fee: '100', networkPassphrase: NP })
    .addOperation(operation).setTimeout(60).build();
  const sim = await rpc.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  if (!sim.result) throw new Error('simulation returned no result');
  return sim;
}

/** The return value of a read-only call. */
export async function read(op: string | S.xdr.Operation): Promise<S.xdr.ScVal> {
  return (await simulate(op)).result!.retval;
}

export const call = (contract: string, method: string, ...args: S.xdr.ScVal[]) => new S.Contract(contract).call(method, ...args);
export const native = async (op: string | S.xdr.Operation) => S.scValToNative(await read(op));
/** Oracle Asset::Stellar(address). */
export const stellarAsset = (sac: string) => S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol('Stellar'), new S.Address(sac).toScVal()]);
/** Oracle Asset::Other(symbol). */
export const otherAsset = (sym: string) => S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol('Other'), S.xdr.ScVal.scvSymbol(sym)]);

/** Ledger entries of contract instances and code by key, with each one's liveUntilLedgerSeq (0 when absent). */
export async function ttlOf(keys: S.xdr.LedgerKey[]) {
  const res = await rpc.getLedgerEntries(...keys);
  const live = new Map<string, number>();
  for (const e of res.entries) live.set(e.key.toXDR('base64'), e.liveUntilLedgerSeq ?? 0);
  return { latest: res.latestLedger, live: keys.map((k) => live.get(k.toXDR('base64')) ?? 0) };
}

const instanceKey = (c: string) => new S.Contract(c).getFootprint();

/**
 * The persistent entries the pool needs to stay usable: the pool, oracle and TESTMXN SAC
 * instances plus every pool or oracle entry (data and code) a read of the config, the reserve
 * list, the reserve and the price touches.
 */
export async function sharedKeys(pool: string, oracle: string, sac: string): Promise<S.xdr.LedgerKey[]> {
  const keys = new Map<string, S.xdr.LedgerKey>();
  const add = (k: S.xdr.LedgerKey) => keys.set(k.toXDR('base64'), k);
  [pool, oracle, sac].forEach((c) => add(instanceKey(c)));
  const p = new PoolContractV2(pool);
  for (const op of [p.getConfig(), p.getReserveList(), p.getReserve(sac), call(oracle, 'lastprice', stellarAsset(sac))]) {
    const sim = await simulate(op);
    // stellar-sdk 17.4 XDR model: unions carry `.type` and the arm in `.value`.
    for (const k of [...sim.transactionData.getReadOnly(), ...sim.transactionData.getReadWrite()] as any[]) {
      if (k.type === 'contractCode') add(k);
      if (k.type === 'contractData') {
        const owner = S.Address.fromScAddress(k.value.contract).toString();
        if (owner === pool || owner === oracle) add(k);
      }
    }
  }
  return [...keys.values()];
}

const LEDGER_SEC = 5;
const days = (ledgers: number) => ((ledgers * LEDGER_SEC) / 86_400).toFixed(1);

/** Admin-signed restoreFootprint or extendFootprintTtl over `keys`. */
export async function footprintTx(kp: S.Keypair, keys: S.xdr.LedgerKey[], kind: 'restore' | 'extend', extendTo: number) {
  const account = await rpc.getAccount(kp.publicKey());
  const data = kind === 'restore' ? new S.SorobanDataBuilder().setReadWrite(keys) : new S.SorobanDataBuilder().setReadOnly(keys);
  const op = kind === 'restore' ? S.Operation.restoreFootprint({}) : S.Operation.extendFootprintTtl({ extendTo });
  const built = new S.TransactionBuilder(account, { fee: '10000', networkPassphrase: NP })
    .addOperation(op).setSorobanData(data.build()).setTimeout(120).build();
  const tx = await rpc.prepareTransaction(built);
  tx.sign(kp);
  const out = await sendAndWait(tx, kind);
  console.log(`  ${kind} ${keys.length} entr${keys.length === 1 ? 'y' : 'ies'}: ${out.hash} (ledger ${out.ledger})`);
  return out;
}

/**
 * Restores archived keys and extends any key with fewer than `minLedgers` left to `extendTo`.
 * Admin-paid. Prints days left before and after. Returns the hashes it made.
 */
export async function ensureTtl(kp: S.Keypair, keys: S.xdr.LedgerKey[], o = { minLedgers: 362_880, extendTo: 518_400 }) {
  const before = await ttlOf(keys);
  console.log(`  TTL before: ${before.live.map((l) => (l ? days(l - before.latest) : 'archived')).join(', ')} days`);
  const steps: { label: string; hash: string; ledger: number }[] = [];
  const archived = keys.filter((_k, i) => before.live[i] <= before.latest);
  if (archived.length) steps.push({ label: 'restore', ...pick(await footprintTx(kp, archived, 'restore', o.extendTo)) });
  const mid = await ttlOf(keys);
  const low = keys.filter((_k, i) => mid.live[i] - mid.latest < o.minLedgers);
  if (low.length) steps.push({ label: 'extend', ...pick(await footprintTx(kp, low, 'extend', o.extendTo)) });
  const after = await ttlOf(keys);
  console.log(`  TTL after:  ${after.live.map((l) => (l ? days(l - after.latest) : 'archived')).join(', ')} days`);
  return { steps, minDaysLeft: Math.min(...after.live.map((l) => ((l - after.latest) * LEDGER_SEC) / 86_400)) };
}

const pick = (o: { hash: string; ledger: number }) => ({ hash: o.hash, ledger: o.ledger });

/** Days until the first of `keys` archives (negative or 0 when one already is). */
export async function minDaysLeft(keys: S.xdr.LedgerKey[]) {
  const t = await ttlOf(keys);
  return Math.min(...t.live.map((l) => ((l - t.latest) * LEDGER_SEC) / 86_400));
}

/** Rewrites packages/shared/src/testnet-blend.ts with the deployed ids. */
export function writeBlend(ids: BlendIds) {
  writeFileSync(BLEND_TS, `// Generated by scripts/deploy-pool.ts on ${ids.deployedAt}. Public Stellar TESTNET contract ids, disclosed by design.
// null until a pool is deployed; rewritten by deploy-pool after a testnet reset.
import type { BlendIds } from './types';

export const TESTNET_BLEND: BlendIds | null = ${JSON.stringify(ids, null, 2).replace(/"([a-zA-Z]+)":/g, '$1:').replace(/"/g, "'")};
`);
  console.log(`wrote ${BLEND_TS}`);
}

/** evidence/2026-12/<phase>/d2/<name>-<iso>.json: public ids and hashes only. */
export function writeEvidence(name: string, obj: object) {
  return writeRun('d2', name, obj);
}

/** The blend-utils testnet ids (factory, backstop, TestnetV2 pool, USDC, oraclemock) and WASM hashes (oraclemock, ...). */
export async function blendUtils(): Promise<{ ids: Record<string, string>; hashes: Record<string, string> }> {
  const r = await fetch(BLEND_UTILS_URL, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`blend-utils ${r.status}`);
  const json = await r.json();
  return { ids: json.ids ?? {}, hashes: json.hashes ?? {} };
}

/** Accounts with a SUCCESS supply into this pool, from the orchestrator's pool_ops; a note when the database is not reachable. */
export async function suppliers(pool: string): Promise<string[] | string> {
  const { Client } = createRequire(new URL('../../services/orchestrator/package.json', import.meta.url))('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://corra:corra@localhost:5434/corra', connectionTimeoutMillis: 3000 });
  try {
    await db.connect();
    const { rows } = await db.query(
      `SELECT DISTINCT account FROM pool_ops WHERE pool_id = $1 AND kind = 'supply' AND status = 'SUCCESS' ORDER BY account`, [pool]);
    return rows.map((r: { account: string }) => r.account);
  } catch (e) {
    return `pool_ops not readable (${(e as Error).message})`;
  } finally {
    await db.end().catch(() => {});
  }
}

/** The deploy-time reserve config: borrowing off (c_factor = l_factor = 0), 1e9 TESTMXN cap, enabled. */
export const RESERVE = {
  index: 0, decimals: 7, c_factor: 0, l_factor: 0, util: 7_000_000, max_util: 9_500_000, r_base: 5_000,
  r_one: 300_000, r_two: 1_000_000, r_three: 10_000_000, reactivity: 20, supply_cap: 10_000_000_000_000_000n, enabled: true,
};

/**
 * Deploy step 7, also pool-check's first step: the pool is the factory's, On-Ice (status 2) with
 * our oracle, take rate 0 and 2 positions, one TESTMXN reserve with borrowing off, our admin.
 */
export async function verifyPool(ids: Pick<BlendIds, 'factory' | 'pool' | 'oracle' | 'asset' | 'admin'>) {
  const p = new PoolContractV2(ids.pool);
  const isPool = S.scValToNative(await read(call(ids.factory, 'is_pool', new S.Address(ids.pool).toScVal())));
  check(isPool === true, 'factory.is_pool(pool)');
  const cfg = PoolContractV2.parsers.getConfig((await read(p.getConfig())).toXDR('base64'));
  check(cfg.status === 2, `status ${cfg.status}, expected 2 (On-Ice, admin)`);
  check(cfg.oracle === ids.oracle, `oracle ${cfg.oracle}`);
  check(cfg.backstopRate === 0, `backstop take rate ${cfg.backstopRate}`);
  check(cfg.maxPositions === 2, `max positions ${cfg.maxPositions}`);
  const list = PoolContractV2.parsers.getReserveList((await read(p.getReserveList())).toXDR('base64'));
  check(list.length === 1 && list[0] === ids.asset, `reserve list ${JSON.stringify(list)}`);
  const r = PoolContractV2.parsers.getReserve((await read(p.getReserve(ids.asset))).toXDR('base64'));
  for (const [k, v] of Object.entries(RESERVE)) {
    check((r.config as any)[k] === v, `reserve ${k} = ${(r.config as any)[k]}, expected ${v}`);
  }
  if (ids.admin) {
    // blend-sdk 4.0.0's PoolContractV2.getAdmin() throws "no such entry: get_admin" (its spec lacks it); the contract has it.
    const admin = await native(call(ids.pool, 'get_admin'));
    check(admin === ids.admin, `admin ${admin}`);
  }
  console.log(`verified: is_pool, status 2 (On-Ice, admin), oracle ours, take rate 0, max positions 2, reserve [${ids.asset}] c_factor 0 l_factor 0 enabled, admin ${ids.admin}`);
  return { cfg, reserve: r };
}
