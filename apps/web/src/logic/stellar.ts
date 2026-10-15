import * as StellarSdk from '@stellar/stellar-sdk';
import { TESTNET } from '@corra/shared';

export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

export const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);

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
