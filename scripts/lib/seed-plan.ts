/**
 * What `pnpm seed-testnet --reuse-keys` still has to do on chain, from what is there now. Pure: the
 * caller reads the chain into a ChainState and executes the actions. After a testnet reset every
 * action is planned; on today's testnet none is.
 *
 * Rules: fund missing accounts; add missing trustlines (market maker: USDC and the six corridor
 * codes; distribution: TESTMXN and TESTPHP); issue only where the holder's balance of that asset is
 * 0 (never a top-up); offers only for the missing selling/buying pairs of the 12 (6 fiats x 2
 * directions); a Stellar Asset Contract only where its instance is missing.
 */
import { FIAT, type FiatCode } from '../../packages/shared/src/corridors';

export type Role = 'usdcIssuer' | 'corridorIssuer' | 'anchorDistribution' | 'marketMaker' | 'feeSponsor';
export const ROLES: Role[] = ['usdcIssuer', 'corridorIssuer', 'anchorDistribution', 'marketMaker', 'feeSponsor'];

export type ChainState = {
  accounts: Record<Role, { exists: boolean; balances: { code: string; issuer: string; balance: string }[] }>;
  /** The market maker's offers, assets as `CODE:ISSUER`. */
  offers: { selling: string; buying: string }[];
  /** SAC instance present, by asset code. */
  sacs: Record<string, boolean>;
};

export type Action =
  | { kind: 'fund'; role: Role }
  | { kind: 'trust'; role: 'marketMaker' | 'anchorDistribution'; codes: string[] }
  | { kind: 'issue'; to: 'marketMaker' | 'anchorDistribution'; code: string; amount: string }
  | { kind: 'offers'; pairs: { selling: string; buying: string }[] }
  | { kind: 'sac'; code: string };

const FIATS = Object.keys(FIAT) as FiatCode[];
export const MM_USDC_BALANCE = 10_000_000;
export const ANCHOR_MXN_BALANCE = 10_000_000 * FIAT.MXN.perUsd;
const amt = (n: number) => n.toFixed(7);

/** `CODE:ISSUER` of USDC and of each corridor code, for these keys. */
export const assetIds = (keys: Record<Role, string>): Record<string, string> => ({
  USDC: `USDC:${keys.usdcIssuer}`,
  ...Object.fromEntries(FIATS.map((f) => [FIAT[f].code, `${FIAT[f].code}:${keys.corridorIssuer}`])),
});

/** The 12 market-maker offers: USDC -> each fiat code and back. */
export const offerPairs = (keys: Record<Role, string>) => {
  const a = assetIds(keys);
  return FIATS.flatMap((f) => [{ selling: a.USDC, buying: a[FIAT[f].code] }, { selling: a[FIAT[f].code], buying: a.USDC }]);
};

export function planSeed(state: ChainState, keys: Record<Role, string>): Action[] {
  const out: Action[] = [];
  for (const role of ROLES) if (!state.accounts[role].exists) out.push({ kind: 'fund', role });

  const ids = assetIds(keys);
  const has = (role: Role, code: string) => state.accounts[role].balances.some((b) => `${b.code}:${b.issuer}` === ids[code]);
  const balanceOf = (role: Role, code: string) => state.accounts[role].balances.find((b) => `${b.code}:${b.issuer}` === ids[code])?.balance ?? '0';

  const mmCodes = ['USDC', ...FIATS.map((f) => FIAT[f].code)];
  const distCodes = [FIAT.MXN.code, FIAT.PHP.code];
  const mmMissing = mmCodes.filter((c) => !has('marketMaker', c));
  const distMissing = distCodes.filter((c) => !has('anchorDistribution', c));
  if (mmMissing.length) out.push({ kind: 'trust', role: 'marketMaker', codes: mmMissing });
  if (distMissing.length) out.push({ kind: 'trust', role: 'anchorDistribution', codes: distMissing });

  // A trustline the plan adds holds 0, so it is issued to as well.
  const zero = (role: Role, code: string) => Number(balanceOf(role, code)) === 0;
  if (zero('marketMaker', 'USDC')) out.push({ kind: 'issue', to: 'marketMaker', code: 'USDC', amount: amt(MM_USDC_BALANCE) });
  for (const f of FIATS) {
    if (zero('marketMaker', FIAT[f].code)) out.push({ kind: 'issue', to: 'marketMaker', code: FIAT[f].code, amount: amt(MM_USDC_BALANCE * FIAT[f].perUsd) });
  }
  if (zero('anchorDistribution', FIAT.MXN.code)) out.push({ kind: 'issue', to: 'anchorDistribution', code: FIAT.MXN.code, amount: amt(ANCHOR_MXN_BALANCE) });

  const open = new Set(state.offers.map((o) => `${o.selling}>${o.buying}`));
  const missingPairs = offerPairs(keys).filter((p) => !open.has(`${p.selling}>${p.buying}`));
  if (missingPairs.length) out.push({ kind: 'offers', pairs: missingPairs });

  for (const code of mmCodes) if (!state.sacs[code]) out.push({ kind: 'sac', code });
  return out;
}
