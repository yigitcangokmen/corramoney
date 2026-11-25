/**
 * Keeps Corra's testnet pool alive: restores archived pool, oracle and TESTMXN SAC entries and
 * extends any with fewer than 21 days left to 30 days. Admin-paid (POOL_ADMIN_SECRET). Also each
 * supplier's position (the pool's entries a read of get_positions(account) touches), for every
 * account with a SUCCESS supply in the orchestrator's pool_ops; without that database, shared entries only.
 *
 * Usage: pnpm pool-ttl
 */
import * as S from '@stellar/stellar-sdk';
import { TESTNET_BLEND } from '../packages/shared/src';
import { call, ensureAdminKey, ensureTtl, sharedKeys, simulate, suppliers, ttlOf, txLink } from './lib/pool';

/**
 * The pool-owned contract-data keys the simulation of get_positions(account) reads (the position, not
 * a hand-built key layout), that exist on chain: an account that never kept a position has none to extend.
 */
async function positionKeys(pool: string, account: string): Promise<S.xdr.LedgerKey[]> {
  const sim = await simulate(call(pool, 'get_positions', new S.Address(account).toScVal()));
  // stellar-sdk 17.4 XDR model: unions carry `.type` and the arm in `.value`.
  const keys = ([...sim.transactionData.getReadOnly(), ...sim.transactionData.getReadWrite()] as any[])
    .filter((k) => k.type === 'contractData' && S.Address.fromScAddress(k.value.contract).toString() === pool);
  if (!keys.length) return [];
  const t = await ttlOf(keys);
  return keys.filter((_k, i) => t.live[i] !== 0);
}

async function main() {
  if (!TESTNET_BLEND) throw new Error('no pool recorded in packages/shared/src/testnet-blend.ts (run pnpm deploy-pool)');
  const { pool, oracle, asset } = TESTNET_BLEND;
  const admin = await ensureAdminKey();
  console.log(`pool ${pool}\noracle ${oracle}\nasset ${asset}`);
  const keys = new Map((await sharedKeys(pool, oracle, asset)).map((k) => [k.toXDR('base64'), k]));
  const shared = keys.size;
  const accounts = await suppliers(pool);
  if (typeof accounts === 'string') {
    console.log(`  user positions skipped: ${accounts}; shared entries only`);
  } else {
    for (const a of accounts) for (const k of await positionKeys(pool, a)) keys.set(k.toXDR('base64'), k);
    console.log(`  ${keys.size - shared} position entr${keys.size - shared === 1 ? 'y' : 'ies'} of ${accounts.length} supplier(s) besides ${shared} shared`);
  }
  const out = await ensureTtl(admin, [...keys.values()]);
  for (const s of out.steps) console.log(`  ${s.label} ${txLink(s.hash)}`);
  console.log(`\nDONE: every entry lives at least ${out.minDaysLeft.toFixed(1)} more days`);
}

main().catch((e) => {
  console.error('FAILED:', e.message ?? e);
  process.exit(1);
});
