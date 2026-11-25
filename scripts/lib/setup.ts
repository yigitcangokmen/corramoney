/**
 * The app's account setup through Corra's POST /setup, for the testnet scripts: a fresh
 * throwaway key asks for the sender's payment account, which goes first (that key signs its own
 * creation, which leaves it with weight 0), then the account's own sponsored setup, signed by the
 * keypair that stands in for Freighter. Stellar TESTNET only.
 */
import * as S from '@stellar/stellar-sdk';
import { TESTNET } from '../../packages/shared/src';
import { assertPaymentAccountSetup } from '../../packages/stellar/src';

const NP = TESTNET.networkPassphrase;
const horizon = new S.Horizon.Server(TESTNET.horizonUrl);

export type SetupResult = { paymentAccount: string | null; paymentAccountHash: string | null; accountHash: string | null };

/** `paymentAccount` false: the account's own setup only (a recipient, which signs nothing Corra submits). */
export async function setupViaCorra(api: string, user: S.Keypair, trust: string[], paymentAccount = true): Promise<SetupResult> {
  const z = paymentAccount ? S.Keypair.random() : null;
  const r = await fetch(`${api}/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: user.publicKey(), trust, ...(z ? { paymentAccount: z.publicKey() } : {}) }),
  });
  const json: any = await r.json();
  if (!r.ok) throw new Error(`POST /setup -> ${r.status} ${JSON.stringify(json)}`);
  const out: SetupResult = { paymentAccount: null, paymentAccountHash: null, accountHash: null };
  if (json.paymentAccountXdr) {
    assertPaymentAccountSetup(json.paymentAccountXdr, user.publicKey(), z!.publicKey(), NP, TESTNET.feeSponsor);
    const tx = S.TransactionBuilder.fromXDR(json.paymentAccountXdr, NP) as S.Transaction;
    tx.sign(z!);
    out.paymentAccountHash = (await horizon.submitTransaction(tx)).hash;
    out.paymentAccount = z!.publicKey();
  }
  if (json.xdr) {
    const tx = S.TransactionBuilder.fromXDR(json.xdr, NP) as S.Transaction;
    tx.sign(user); // Freighter in the app
    out.accountHash = (await horizon.submitTransaction(tx)).hash;
  }
  return out;
}

/** The account's current sequence, for building on the payment account. */
export const sequenceOf = async (account: string) => (await horizon.loadAccount(account)).sequence;
