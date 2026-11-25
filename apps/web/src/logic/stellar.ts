import * as StellarSdk from '@stellar/stellar-sdk';
import { formatUnits, parseUnits, TESTNET } from '@corra/shared';
import { isPaymentAccount } from '@corra/stellar';

export const HORIZON_URL = 'https://horizon-testnet.stellar.org';

export const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);

export async function fundWithFriendbot(pubkey: string) {
  const r = await fetch('https://friendbot.stellar.org?addr=' + encodeURIComponent(pubkey));
  if (!r.ok) throw new Error('Friendbot failed: ' + r.status);
  return r.json();
}

export type AccountView = {
  exists: boolean; mxnTrusted: boolean; testmxn: string; spendable: string; others: Record<string, string>;
  /** The sender's payment account (the source of every payment and pool move it signs), or null when it has none. */
  paymentAccount: string | null;
  /** TESTPHP from Corra's issuer: trusted, and spendable (balance minus selling liabilities). */
  phpTrusted: boolean; phpSpendable: string;
};

/** Anyone can add a sender as a signer of their own accounts, so the listing is read to its end, up to this many pages of 200. */
const MAX_SIGNER_PAGES = 50;

/**
 * The sender's payment account and its current sequence, from Horizon's `?signer=` (no Corra
 * database): an account the sponsor set up whose only signer is the sender. The lowest id wins;
 * the server accepts any of them as a source. null when it has none (never set up, or merged).
 * `known` (the one found before) is read directly and kept while it still is one; a 404 or a
 * reshaped account falls back to the listing. Horizon lists ?signer= by ascending account id, so
 * the first page with a match holds the lowest.
 */
export async function readPaymentAccount(pk: string, known?: string | null): Promise<{ id: string; sequence: string } | null> {
  if (known) {
    try {
      const rec: any = await horizon.loadAccount(known);
      if (isPaymentAccount(rec, pk, TESTNET.feeSponsor)) return { id: rec.id, sequence: rec.sequence };
    } catch (e: any) {
      if (e?.response?.status !== 404) throw e;
    }
  }
  let page = await horizon.accounts().forSigner(pk).limit(200).call();
  for (let n = 1; ; n++) {
    const mine = page.records.filter((r: any) => isPaymentAccount(r, pk, TESTNET.feeSponsor));
    if (mine.length) {
      mine.sort((a, b) => (a.id < b.id ? -1 : 1));
      return { id: mine[0].id, sequence: mine[0].sequence };
    }
    if (page.records.length < 200 || n >= MAX_SIGNER_PAGES) return null;
    page = await page.next();
  }
}

/**
 * The account's TESTMXN as Horizon reports it, and its payment account. `spendable` is the balance
 * minus selling liabilities, exactly what Corra checks before it takes a payment from the balance.
 * null when Horizon could not be reached; a 404 is an account that does not exist yet.
 * `knownPaymentAccount` spares the ?signer= listing while that account still is the payment account.
 */
export async function readAccount(pk: string, knownPaymentAccount?: string | null): Promise<AccountView | null> {
  let acct, paymentAccount;
  try {
    // A payment account can exist before its signer does (its own setup lands first).
    [acct, paymentAccount] = await Promise.all([
      horizon.loadAccount(pk).catch((e: any) => (e?.response?.status === 404 ? null : Promise.reject(e))),
      readPaymentAccount(pk, knownPaymentAccount),
    ]);
  } catch {
    return null;
  }
  const pa = paymentAccount?.id ?? null;
  if (!acct) return { exists: false, mxnTrusted: false, testmxn: '0', spendable: '0', others: {}, paymentAccount: pa, phpTrusted: false, phpSpendable: '0' };
  const v: AccountView = { exists: true, mxnTrusted: false, testmxn: '0', spendable: '0', others: {}, paymentAccount: pa, phpTrusted: false, phpSpendable: '0' };
  for (const bal of acct.balances as any[]) {
    // A TEST* token only counts from Corra's issuer: anyone can issue an asset with the same code.
    if (!bal.asset_code?.startsWith('TEST') || bal.asset_issuer !== TESTNET.corridorIssuer) continue;
    if (bal.asset_code === 'TESTMXN') {
      const raw = parseUnits(bal.balance) - parseUnits(bal.selling_liabilities ?? '0');
      v.mxnTrusted = true;
      v.testmxn = bal.balance;
      v.spendable = formatUnits(raw > 0n ? raw : 0n);
    } else {
      if (bal.asset_code === 'TESTPHP') {
        const raw = parseUnits(bal.balance) - parseUnits(bal.selling_liabilities ?? '0');
        v.phpTrusted = true;
        v.phpSpendable = formatUnits(raw > 0n ? raw : 0n);
      }
      if (parseUnits(bal.balance) > 0n) v.others[bal.asset_code] = bal.balance;
    }
  }
  return v;
}
