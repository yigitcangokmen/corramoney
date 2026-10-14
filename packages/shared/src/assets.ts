import { TESTNET } from './testnet';
import { FIAT, type FiatCode } from './corridors';

/** Stellar asset. No issuer means native XLM. */
export type AssetId = { code: string; issuer?: string };

export const USDC: AssetId = { code: 'USDC', issuer: TESTNET.usdcIssuer };

export const fiatAsset = (f: FiatCode): AssetId => ({
  code: FIAT[f].code,
  issuer: TESTNET.corridorIssuer,
});

export const assetKey = (a: AssetId) => (a.issuer ? `${a.code}:${a.issuer}` : 'native');
