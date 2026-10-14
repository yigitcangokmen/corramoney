import * as StellarSdk from '@stellar/stellar-sdk';
import { TESTNET } from '@corra/shared';

export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
export const USDC_ISSUER = 'GASJHGUGQUGQPL6RPGEKFCSPHLU4YSTZ6HQZVMATGUQHR74DSPBNIBZV';
// Used only by the hidden legacy Earn code. The old distribution key was public in git history
// and is burned; no secret ships in this app. Earn returns as direct Blend/DeFindex deposits.
export const DIST_SECRET: string = (import.meta as any).env?.VITE_LEGACY_DIST_SECRET ?? '';
export const DIST_PUBLIC = 'GD2ZMN42FWXKJSI67HKFCK3IPZCZU2AETPSABRV3SHJSU46FEXKXGP4Q';

export const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
export const USDC = new StellarSdk.Asset('USDC', USDC_ISSUER);

export async function fundWithFriendbot(pubkey: string) {
  const r = await fetch('https://friendbot.stellar.org?addr=' + encodeURIComponent(pubkey));
  if (!r.ok) throw new Error('Friendbot failed: ' + r.status);
  return r.json();
}

export async function getBalances(pubkey: string): Promise<Record<string, string>> {
  try {
    const acct = await horizon.loadAccount(pubkey);
    const b: Record<string, string> = {};
    for (const bal of acct.balances) {
      if (bal.asset_type === 'native') b.XLM = bal.balance;
      // A TEST* token only counts from Corra's issuer: anyone can issue an asset with the same code.
      else if ('asset_code' in bal && bal.asset_code &&
        (!bal.asset_code.startsWith('TEST') || bal.asset_issuer === TESTNET.corridorIssuer)) b[bal.asset_code] = bal.balance;
    }
    return b;
  } catch { return {}; }
}
