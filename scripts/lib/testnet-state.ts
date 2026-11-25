/**
 * Read-only views of Corra's team accounts on Stellar TESTNET, shared by seed-testnet --reuse-keys,
 * redeploy-after-reset and ops-check. Nothing here signs or submits.
 */
import * as S from '@stellar/stellar-sdk';
import { DEST_FIATS, FIAT, type FiatCode } from '../../packages/shared/src/corridors';
import { ROLES, type ChainState, type Role } from './seed-plan';

export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const NP = S.Networks.TESTNET;
export const horizon = new S.Horizon.Server(HORIZON_URL);
export const rpc = new S.rpc.Server(RPC_URL);
const FIATS = Object.keys(FIAT) as FiatCode[];

/** The account, or null when Horizon says 404 (never created, or wiped by a reset). */
export async function accountOrNull(pk: string) {
  try {
    return await horizon.loadAccount(pk);
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/** Each account's sequence (null: absent): equal before and after a run means nothing was submitted from it. */
export async function sequences(pks: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const pk of pks) out[pk] = (await accountOrNull(pk))?.sequence ?? null;
  return out;
}

/** The classic assets USDC and TEST* as stellar-sdk Assets, for these issuers. */
export function assetsOf(usdcIssuer: string, corridorIssuer: string): Record<string, S.Asset> {
  return { USDC: new S.Asset('USDC', usdcIssuer), ...Object.fromEntries(FIATS.map((f) => [FIAT[f].code, new S.Asset(FIAT[f].code, corridorIssuer)])) };
}

/** Which Stellar Asset Contract instances exist on chain, by code. */
export async function sacInstances(assets: Record<string, S.Asset>): Promise<Record<string, boolean>> {
  const codes = Object.keys(assets);
  const keys = codes.map((c) => new S.Contract(assets[c].contractId(NP)).getFootprint());
  const res = await rpc.getLedgerEntries(...keys);
  const found = new Set(res.entries.map((e) => e.key.toXDR('base64')));
  return Object.fromEntries(codes.map((c, i) => [c, found.has(keys[i].toXDR('base64'))]));
}

/** What seed-plan needs: the five funded roles with their balances, the market maker's offers, the SACs. */
export async function readChainState(keys: Record<Role, string>): Promise<ChainState> {
  const accounts = {} as ChainState['accounts'];
  for (const role of ROLES) {
    const a = await accountOrNull(keys[role]);
    accounts[role] = {
      exists: !!a,
      balances: (a?.balances ?? []).filter((b: any) => b.asset_code).map((b: any) => ({ code: b.asset_code, issuer: b.asset_issuer, balance: b.balance })),
    };
  }
  const offers: ChainState['offers'] = [];
  if (accounts.marketMaker.exists) {
    const id = (x: any) => (x.asset_type === 'native' ? 'XLM' : `${x.asset_code}:${x.asset_issuer}`);
    let page = await horizon.offers().forAccount(keys.marketMaker).limit(200).call();
    for (let n = 0; n < 5; n++) {
      offers.push(...page.records.map((o: any) => ({ selling: id(o.selling), buying: id(o.buying) })));
      if (page.records.length < 200) break;
      page = await page.next();
    }
  }
  return { accounts, offers, sacs: await sacInstances(assetsOf(keys.usdcIssuer, keys.corridorIssuer)) };
}

/** TESTMXN -> each destination code, strict-receive 1000: the best path's source amount, or null. */
export async function corridorPaths(corridorIssuer: string): Promise<{ code: string; sourceAmount: string | null; hops: string }[]> {
  const mxn = new S.Asset(FIAT.MXN.code, corridorIssuer);
  const out = [];
  for (const f of DEST_FIATS) {
    const res = await horizon.strictReceivePaths([mxn], new S.Asset(FIAT[f].code, corridorIssuer), '1000').call();
    const best = res.records[0];
    out.push({
      code: FIAT[f].code, sourceAmount: best?.source_amount ?? null,
      hops: best ? [best.source_asset_code, ...best.path.map((p) => p.asset_code ?? 'XLM'), best.destination_asset_code].join(' -> ') : '',
    });
  }
  return out;
}

/** A channel account as create-channels leaves it: XLM only, its own signer at weight 1, thresholds 0, no sponsor. */
export async function channelState(pk: string) {
  const a: any = await accountOrNull(pk);
  if (!a) return { exists: false, xlm: 0, ownSignerOnly: false };
  const native = a.balances.find((b: any) => b.asset_type === 'native');
  const ownSignerOnly = a.balances.length === 1 && a.signers.length === 1 && a.signers[0].key === pk && a.signers[0].weight === 1
    && !a.sponsor && Number(a.subentry_count ?? 0) === 0;
  return { exists: true, xlm: Number(native?.balance ?? 0), ownSignerOnly };
}

/** The destination codes `pk` does not trust from the corridor issuer (all five when it does not exist). */
export async function missingDestTrust(pk: string, corridorIssuer: string): Promise<string[]> {
  const a: any = await accountOrNull(pk);
  const codes = DEST_FIATS.map((f) => FIAT[f].code);
  if (!a) return codes;
  return codes.filter((c) => !a.balances.some((b: any) => b.asset_code === c && b.asset_issuer === corridorIssuer));
}

/** The XLM of an account, or null when it does not exist. */
export async function xlmOf(pk: string): Promise<number | null> {
  const a: any = await accountOrNull(pk);
  return a ? Number(a.balances.find((b: any) => b.asset_type === 'native')?.balance ?? 0) : null;
}
