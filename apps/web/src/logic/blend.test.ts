import * as S from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolContractV2, ReserveV2 } from '@blend-capital/blend-sdk';
import { assertPoolSubmit } from '@corra/stellar';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSubmit, PoolMissing, PoolSimError, readPool, RPC_TIMEOUT_MS, type PoolCfg } from './blend';
import * as PF from '../../../../packages/stellar/test/pool-fixtures';

const NP = S.Networks.TESTNET;
const cfg: PoolCfg = { rpcUrl: 'https://rpc.test', networkPassphrase: NP, poolId: PF.FAKE_POOL, asset: PF.FAKE_SAC };
const user = S.Keypair.random();
const pk = user.publicKey();
/** The user's payment account: the transaction source; it holds the sequence, the user signs. */
const PAY = S.Keypair.random().publicKey();
const NOW = 1_800_000_000;

const sym = (s: string) => S.xdr.ScVal.scvSymbol(s);
const u32 = (n: number) => S.xdr.ScVal.scvU32(n);
const i128 = (n: bigint) => S.nativeToScVal(n, { type: 'i128' });
/** A Soroban struct: a map with symbol keys in order. */
const struct = (f: Record<string, S.xdr.ScVal>) =>
  S.xdr.ScVal.scvMap(Object.keys(f).sort().map((k) => new S.xdr.ScMapEntry({ key: sym(k), val: f[k] })));
const u32Map = (m: [number, bigint][]) => S.xdr.ScVal.scvMap(m.map(([k, v]) => new S.xdr.ScMapEntry({ key: u32(k), val: i128(v) })));

/** get_reserve as the live pool answers it (shape read from testnet). */
const reserveVal = (d: { bRate?: bigint; dRate?: bigint; bSupply?: bigint; dSupply?: bigint } = {}) => struct({
  asset: new S.Address(PF.FAKE_SAC).toScVal(),
  config: struct({
    c_factor: u32(0), decimals: u32(7), enabled: S.xdr.ScVal.scvBool(true), index: u32(0), l_factor: u32(0), max_util: u32(9_500_000),
    r_base: u32(5_000), r_one: u32(300_000), r_three: u32(10_000_000), r_two: u32(1_000_000), reactivity: u32(20),
    supply_cap: i128(10_000_000_000_000_000n), util: u32(7_000_000),
  }),
  data: struct({
    b_rate: i128(d.bRate ?? 1_000_000_000_000n), b_supply: i128(d.bSupply ?? 0n), backstop_credit: i128(0n),
    d_rate: i128(d.dRate ?? 1_000_000_000_000n), d_supply: i128(d.dSupply ?? 0n), ir_mod: i128(10_000_000n),
    last_time: S.nativeToScVal(NOW, { type: 'u64' }),
  }),
  scalar: i128(10_000_000n),
});
const configVal = (status = 2, bstop = 0) => struct({
  bstop_rate: u32(bstop), max_positions: u32(2), min_collateral: i128(0n), oracle: new S.Address(PF.FAKE_SAC).toScVal(), status: u32(status),
});
const positionsVal = (supply: [number, bigint][]) => struct({ collateral: u32Map([]), liabilities: u32Map([]), supply: u32Map(supply) });

const fnOf = (tx: S.Transaction) => String((tx.operations[0] as any).func.value.functionName);
const success = (retval: S.xdr.ScVal, extra: object = {}) => ({
  _parsed: true, id: '1', latestLedger: 5_900_000, events: [], minResourceFee: '0', cost: { cpuInsns: '0', memBytes: '0' },
  transactionData: new S.SorobanDataBuilder(), result: { auth: [], retval }, ...extra,
});

/** Answers reads by function name. */
function mockReads(answers: Record<string, S.xdr.ScVal | { error: string }>) {
  const seen: S.Transaction[] = [];
  vi.spyOn(S.rpc.Server.prototype, 'simulateTransaction').mockImplementation(async (tx: any) => {
    seen.push(tx);
    const a = answers[fnOf(tx)];
    if (!a) throw new Error('unexpected read ' + fnOf(tx));
    return ('error' in a ? { id: '1', latestLedger: 1, events: [], _parsed: true, error: a.error } : success(a)) as any;
  });
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe('buildSubmit', () => {
  function mockSupplySim() {
    // The payment account's sequence comes from the caller: the RPC is never asked for it.
    vi.spyOn(S.rpc.Server.prototype, 'getAccount').mockRejectedValue(new Error('Account not found: ' + PAY));
    return vi.spyOn(S.rpc.Server.prototype, 'simulateTransaction').mockImplementation(async (tx: any) => {
      const ic = tx.operations[0].func.value;
      const amount = S.scValToNative(ic.args[3])[0].amount;
      // As a live supply simulation: one source-account entry rooted at this submit, with the SAC transfer.
      const auth = [PF.sourceEntry(PF.invocation(S.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(ic),
        [PF.transfer(pk, PF.FAKE_POOL, amount)]))];
      const data = new S.SorobanDataBuilder().setResourceFee('688005')
        .setReadOnly([new S.Contract(PF.FAKE_SAC).getFootprint(), new S.Contract(PF.FAKE_POOL).getFootprint()])
        .setReadWrite([PF.trustlineKey(pk)]);
      return success(S.xdr.ScVal.scvVoid(), { transactionData: data, minResourceFee: '688005', result: { auth, retval: S.xdr.ScVal.scvVoid() } }) as any;
    });
  }

  it('PB1 builds a blob that, signed once, passes the server validator; fee = resource fee', async () => {
    mockSupplySim();
    const { xdr, resourceFee } = await buildSubmit(cfg, pk, PAY, '41', 'supply', 200_000_000n, NOW);
    expect(resourceFee).toBe(688_005n);
    const tx = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
    expect(tx.fee).toBe('688005');
    // 4.5: the payment account's next sequence is the transaction's; the user is the operation source.
    expect(tx.source).toBe(PAY);
    expect(tx.operations[0].source).toBe(pk);
    expect(tx.sequence).toBe('42');
    tx.sign(user);
    const facts = assertPoolSubmit(tx.toXDR(), PF.SCOPE, NP, NOW, S.Keypair.random().publicKey());
    expect(facts).toMatchObject({ account: pk, paymentAccount: PAY, kind: 'supply', amountRaw: 200_000_000n, resourceFee: 688_005n, maxTime: NOW + 180 });
  });

  it('PB8 a payment account just created that the RPC does not know yet builds on its starting sequence (S3)', async () => {
    mockSupplySim();
    // A new account's sequence is its creation ledger << 32.
    const start = (5_900_001n << 32n).toString();
    const tx = S.TransactionBuilder.fromXDR((await buildSubmit(cfg, pk, PAY, start, 'supply', 200_000_000n, NOW)).xdr, NP) as S.Transaction;
    expect(tx.source).toBe(PAY);
    expect(tx.sequence).toBe((5_900_001n << 32n) + 1n + '');
    expect(S.rpc.Server.prototype.getAccount).not.toHaveBeenCalled();
  });

  it('PB7 a browser clock 150 s fast or slow still builds a blob Corra accepts by its own clock', async () => {
    mockSupplySim();
    for (const skew of [150, -150]) {
      const tx = S.TransactionBuilder.fromXDR((await buildSubmit(cfg, pk, PAY, '41', 'supply', 200_000_000n, NOW + skew)).xdr, NP) as S.Transaction;
      tx.sign(user);
      // Corra sees it 10 s after the build (the Freighter prompt), by its own correct clock.
      expect(() => assertPoolSubmit(tx.toXDR(), PF.SCOPE, NP, NOW + 10, S.Keypair.random().publicKey()), String(skew)).not.toThrow();
    }
  });

  it('PB6 a simulation error carries Blend\'s or the token\'s error number; an archived entry is restore', async () => {
    const sim = vi.spyOn(S.rpc.Server.prototype, 'simulateTransaction');
    for (const [error, code] of [['HostError: Error(Contract, #1206)', 1206], ['HostError: Error(Contract, #10)', 10], ['HostError: Error(Budget, ExceededLimit)', 'unknown']] as const) {
      sim.mockResolvedValueOnce({ id: '1', latestLedger: 1, events: [], _parsed: true, error } as any);
      const e = await buildSubmit(cfg, pk, PAY, '41', 'supply', 1n, NOW).catch((x) => x);
      expect(e).toBeInstanceOf(PoolSimError);
      expect(e.code).toBe(code);
    }
    sim.mockResolvedValueOnce(success(S.xdr.ScVal.scvVoid(), {
      restorePreamble: { minResourceFee: '100', transactionData: new S.SorobanDataBuilder() },
    }) as any);
    const e = await buildSubmit(cfg, pk, PAY, '41', 'withdraw', 1n, NOW).catch((x) => x);
    expect(e).toBeInstanceOf(PoolSimError);
    expect(e.code).toBe('restore');
  });
});

describe('readPool', () => {
  it('PB2 utilisation 0: APR 0, underlying = bTokens x bRate / 1e12', async () => {
    mockReads({ get_reserve: reserveVal({ bRate: 1_100_000_000_000n, bSupply: 75_000_000n }), get_config: configVal(), get_positions: positionsVal([[0, 75_000_000n]]) });
    const r = await readPool(cfg, pk);
    expect(r).toMatchObject({ status: 2, backstopRate: 0, index: 0, bTokens: 75_000_000n, underlyingRaw: 82_500_000n, supplyApr: 0, utilization: 0 });
  });

  it('PB3 no supply key (after a full withdraw) is 0', async () => {
    mockReads({ get_reserve: reserveVal(), get_config: configVal(), get_positions: positionsVal([]) });
    expect(await readPool(cfg, pk)).toMatchObject({ bTokens: 0n, underlyingRaw: 0n });
  });

  it('PB4 a 50% utilised reserve with take rate 0.2 shows blend-sdk\'s positive APR', async () => {
    const rv = reserveVal({ bSupply: 100_000_000n, dSupply: 50_000_000n });
    mockReads({ get_reserve: rv, get_config: configVal(0, 2_000_000), get_positions: positionsVal([[0, 10_000_000n]]) });
    const r = await readPool(cfg, pk);
    const c = PoolContractV2.parsers.getReserve(rv.toXDR('base64'));
    const ref = new ReserveV2(PF.FAKE_POOL, PF.FAKE_SAC, c.config, c.data, undefined, undefined, 0, 0, 0, 0, 5_900_000);
    ref.setRates(2_000_000n);
    expect(r.utilization).toBeCloseTo(0.5);
    expect(r.supplyApr).toBeGreaterThan(0);
    expect(r.supplyApr).toBe(ref.supplyApr);
  });

  it('PB4b a passed config skips the config read', async () => {
    const seen = mockReads({ get_reserve: reserveVal(), get_positions: positionsVal([]) });
    expect((await readPool(cfg, pk, { config: { status: 3, backstopRate: 0 } })).status).toBe(3);
    expect(seen.map(fnOf).sort()).toEqual(['get_positions', 'get_reserve']);
  });

  it('PB5 a missing pool or reserve is PoolMissing; other errors are rethrown', async () => {
    mockReads({ get_reserve: { error: 'HostError: Error(Storage, MissingValue)' }, get_config: configVal(), get_positions: positionsVal([]) });
    await expect(readPool(cfg, pk)).rejects.toBeInstanceOf(PoolMissing);
    vi.restoreAllMocks();
    mockReads({ get_reserve: { error: 'HostError: Error(Budget, ExceededLimit)' }, get_config: configVal(), get_positions: positionsVal([]) });
    const e = await readPool(cfg, pk).catch((x) => x);
    expect(e).not.toBeInstanceOf(PoolMissing);
    expect(e.message).toMatch(/ExceededLimit/);
  });

  it('PB7 get_positions is built with Contract.call (blend-sdk 4.0.0\'s builder is broken)', async () => {
    expect(() => new PoolContractV2(PF.FAKE_POOL).getPositions(pk)).toThrow(/Missing field address/);
    const seen = mockReads({ get_reserve: reserveVal(), get_config: configVal(), get_positions: positionsVal([]) });
    await readPool(cfg, pk);
    const call = seen.find((t) => fnOf(t) === 'get_positions')!;
    const args = (call.operations[0] as any).func.value.args;
    expect(args).toHaveLength(1);
    expect(S.scValToNative(args[0])).toBe(pk);
  });
});

describe('Stellar RPC', () => {
  it('PB8 an RPC that never answers fails the read after the request timeout instead of holding it', async () => {
    const server = createServer(() => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const t0 = Date.now();
      await expect(readPool({ ...cfg, rpcUrl: url }, pk)).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(RPC_TIMEOUT_MS + 2_000);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }, RPC_TIMEOUT_MS + 5_000);
});
