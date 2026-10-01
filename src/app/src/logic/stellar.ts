import * as StellarSdk from '@stellar/stellar-sdk';

export const HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const CORRIDOR_ISSUER = 'GCPDDGIMNUZJCSG2TCJNUPB3X7HQ7NASVAW66UL7GT7ZHNA35N2YNDOS';

export const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
export const USDC = new StellarSdk.Asset('USDC', USDC_ISSUER);

export async function fundWithFriendbot(pubkey: string) {
  const r = await fetch('https://friendbot.stellar.org?addr=' + encodeURIComponent(pubkey));
  return r.json();
}

export async function getBalances(pubkey: string): Promise<Record<string, string>> {
  try {
    const acct = await horizon.loadAccount(pubkey);
    const b: Record<string, string> = {};
    for (const bal of acct.balances) {
      if (bal.asset_type === 'native') b.XLM = bal.balance;
      else if ('asset_code' in bal && bal.asset_code) b[bal.asset_code] = bal.balance;
    }
    return b;
  } catch { return {}; }
}
