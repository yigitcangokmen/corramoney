import type { AssetId } from './assets';

export const DECIMALS = 7;
const SCALE = 10n ** BigInt(DECIMALS);
/** Stellar amounts are int64 stroops. */
export const MAX_RAW = 2n ** 63n - 1n;

const bounded = (raw: bigint, what: string) => {
  if (raw > MAX_RAW) throw new Error(`${what} exceeds Stellar's maximum amount`);
  return raw;
};

export type Money = {
  readonly asset: AssetId;
  readonly raw: bigint;
};

export function parseUnits(d: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(d)) throw new Error(`invalid amount: "${d}"`);
  const [whole, frac = ''] = d.split('.');
  if (frac.length > DECIMALS) throw new Error(`more than ${DECIMALS} decimals: "${d}"`);
  return bounded(BigInt(whole) * SCALE + BigInt(frac.padEnd(DECIMALS, '0')), `amount "${d}"`);
}

export function formatUnits(raw: bigint): string {
  if (raw < 0n) throw new Error('negative amount');
  const whole = raw / SCALE;
  const frac = (raw % SCALE).toString().padStart(DECIMALS, '0');
  return `${whole}.${frac}`;
}

export function sameAsset(a: AssetId, b: AssetId): boolean {
  return a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);
}

function assertSameAsset(a: AssetId, b: AssetId) {
  if (!sameAsset(a, b)) throw new Error(`asset mismatch: ${a.code} vs ${b.code}`);
}

export const fromDecimal = (asset: AssetId, d: string): Money => ({ asset, raw: parseUnits(d) });

export const toDecimal = (m: Money): string => formatUnits(m.raw);

export const add = (a: Money, b: Money): Money => {
  assertSameAsset(a.asset, b.asset);
  return { asset: a.asset, raw: a.raw + b.raw };
};

export const compare = (a: Money, b: Money): -1 | 0 | 1 => {
  assertSameAsset(a.asset, b.asset);
  return a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0;
};

/** Rounds up to `decimals` places, e.g. a 7-decimal cap to whole centavos for a fiat deposit. */
export const roundUp = (m: Money, decimals: number): Money => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > DECIMALS) throw new Error(`invalid decimals: ${decimals}`);
  const step = 10n ** BigInt(DECIMALS - decimals);
  return { asset: m.asset, raw: ((m.raw + step - 1n) / step) * step };
};

/** Grows an amount by basis points, rounding up so a sendMax cap is never short. */
export const withSlippage = (m: Money, bps: number): Money => {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`invalid bps: ${bps}`);
  const scaled = m.raw * BigInt(10_000 + bps);
  const raw = bounded((scaled + 9_999n) / 10_000n, 'amount with slippage');
  return { asset: m.asset, raw };
};
