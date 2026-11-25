/**
 * Blend pool reads and the user's `submit` builder, over Stellar RPC simulations. stellar-sdk and
 * blend-sdk only, no browser APIs: pool.ts imports it lazily, scripts/pool-check.ts directly, so
 * the go/no-go script proves the very builder the app uses.
 */
import * as S from '@stellar/stellar-sdk';
import { PoolContractV2, ReserveV2 } from '@blend-capital/blend-sdk';

/**
 * The submit's time bound, from the builder's clock. Corra accepts maxTime in (now, now + 360] by
 * its own clock, so 180 s sits in the middle: a browser clock up to about 3 minutes fast or slow
 * still gets through, where now + 300 failed with a clock only 60 s fast.
 */
export const SUBMIT_TTL_SEC = 180;

export type PoolCfg = { rpcUrl: string; networkPassphrase: string; poolId: string; asset: string };

export type PoolRead = {
  status: number;
  backstopRate: number;
  /** The reserve's index in the pool (the key of the user's supply). */
  index: number;
  bTokens: bigint;
  underlyingRaw: bigint;
  supplyApr: number;
  utilization: number;
  ledger: number;
};

/** The pool or its reserve is not on this network (e.g. after a testnet reset). */
export class PoolMissing extends Error {}

/** The pool refused the transaction in simulation: a Blend or token error number, an archived entry, or other. */
export class PoolSimError extends Error {
  constructor(readonly code: number | 'restore' | 'unknown', message: string) {
    super(message);
    this.name = 'PoolSimError';
  }
}

export const STATUS_LABEL: Record<number, string> = {
  0: 'Active', 1: 'Active', 2: 'On-Ice (admin)', 3: 'On-Ice', 4: 'Frozen (admin)', 5: 'Frozen', 6: 'Setup',
};

const servers = new Map<string, S.rpc.Server>();
/** Per RPC request: stellar-sdk 17.4 sets no abort signal without it, and a stalled read would hold the card. */
export const RPC_TIMEOUT_MS = 10_000;
const rpcOf = (url: string) => {
  let s = servers.get(url);
  if (!s) servers.set(url, (s = new S.rpc.Server(url, { allowHttp: url.startsWith('http://'), timeout: RPC_TIMEOUT_MS })));
  return s;
};

const opOf = (op: string | S.xdr.Operation) => (typeof op === 'string' ? S.xdr.Operation.fromXDR(op, 'base64') : op);

/** A read-only call simulated with `pk` as the (unused) source: its return value and the ledger it was read at. */
async function simRead(cfg: PoolCfg, pk: string, op: string | S.xdr.Operation) {
  const tx = new S.TransactionBuilder(new S.Account(pk, '0'), { fee: '100', networkPassphrase: cfg.networkPassphrase })
    .addOperation(opOf(op)).setTimeout(60).build();
  const sim = await rpcOf(cfg.rpcUrl).simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return { retval: sim.result!.retval.toXDR('base64'), ledger: sim.latestLedger };
}

const MISSING = /MissingValue|non-existing|does not exist|contract not found/i;

/**
 * The user's position in underlying units and the reserve's computed rate. Nothing is hardcoded:
 * the rate comes from Blend's own interest model over the reserve's live utilisation.
 */
export async function readPool(cfg: PoolCfg, pk: string, opts?: { config?: { status: number; backstopRate: number } }): Promise<PoolRead> {
  const pool = new PoolContractV2(cfg.poolId);
  let reserveRead, configRead;
  try {
    [reserveRead, configRead] = await Promise.all([
      simRead(cfg, pk, pool.getReserve(cfg.asset)),
      opts?.config ? null : simRead(cfg, pk, pool.getConfig()),
    ]);
  } catch (e) {
    if (MISSING.test(String((e as Error)?.message ?? e))) throw new PoolMissing((e as Error).message);
    throw e;
  }
  // blend-sdk 4.0.0's PoolContractV2.getPositions(user) builds the V1 call ("Missing field address").
  const positionsRead = await simRead(cfg, pk, new S.Contract(cfg.poolId).call('get_positions', new S.Address(pk).toScVal()));
  const r = PoolContractV2.parsers.getReserve(reserveRead.retval);
  const config = opts?.config ?? PoolContractV2.parsers.getConfig(configRead!.retval);
  const positions = PoolContractV2.parsers.getPositions(positionsRead.retval);
  const reserve = new ReserveV2(cfg.poolId, cfg.asset, r.config, r.data, undefined, undefined, 0, 0, 0, 0, reserveRead.ledger);
  reserve.setRates(BigInt(config.backstopRate));
  // A full withdraw removes the key rather than leaving 0.
  const bTokens = positions.supply.get(r.config.index) ?? 0n;
  return {
    status: config.status, backstopRate: config.backstopRate, index: r.config.index, bTokens,
    underlyingRaw: reserve.toAssetFromBToken(bTokens), supplyApr: reserve.supplyApr, utilization: reserve.getUtilizationFloat(),
    ledger: reserveRead.ledger,
  };
}

/**
 * The payment account's next transaction: one `submit` whose operation source is the user
 * (from = spender = to = the user, one request), its auth (a source-account credential of the
 * operation source) and resources from simulation, fee = the resource fee (inclusion 0: Corra's
 * fee-bump bids), valid for SUBMIT_TTL_SEC. The user signs it alone. Unsigned.
 * `sequence` is the payment account's current one as the caller read it: an account just created
 * may not be known to the RPC yet (S3).
 */
export async function buildSubmit(cfg: PoolCfg, pk: string, paymentAccount: string, sequence: string, kind: 'supply' | 'withdraw',
  amountRaw: bigint, nowSec = Math.floor(Date.now() / 1000)): Promise<{ xdr: string; resourceFee: bigint }> {
  const rpc = rpcOf(cfg.rpcUrl);
  const account = new S.Account(paymentAccount, sequence);
  const call = S.Operation.fromXDRObject(opOf(new PoolContractV2(cfg.poolId).submit({
    from: pk, spender: pk, to: pk, requests: [{ request_type: kind === 'supply' ? 0 : 1, address: cfg.asset, amount: amountRaw }],
  }))) as S.Operation.InvokeHostFunction;
  const tx = new S.TransactionBuilder(account, { fee: '0', networkPassphrase: cfg.networkPassphrase })
    .addOperation(S.Operation.invokeHostFunction({ func: call.func, auth: call.auth, source: pk }))
    .setTimebounds(0, nowSec + SUBMIT_TTL_SEC).build();
  const sim = await rpc.simulateTransaction(tx);
  if (S.rpc.Api.isSimulationError(sim)) {
    const n = /Error\(Contract, #(\d+)\)/.exec(sim.error);
    throw new PoolSimError(n ? Number(n[1]) : 'unknown', sim.error);
  }
  if (S.rpc.Api.isSimulationRestore(sim)) throw new PoolSimError('restore', 'a pool ledger entry is archived');
  const built = S.rpc.assembleTransaction(tx, sim).build();
  // stellar-sdk 17.4 XDR object model: the envelope's arm is `.value`, the Soroban data `ext.value`.
  const env = built.toEnvelope() as any;
  return { xdr: built.toXDR(), resourceFee: BigInt(env.value.tx.ext.value.resourceFee) };
}
