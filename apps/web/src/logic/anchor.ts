/**
 * SEP-10, SEP-24 and SEP-38 against the anchor, in the browser, through SDF's wallet SDK.
 * Corra's server never logs in on the user's behalf: the user's Freighter signs the SEP-10
 * challenge here. The orchestrator only adds its client_domain co-signature (a sequence-0
 * challenge that can never be submitted), which is what makes the anchor attribute the deposit
 * to Corra and send Corra its signed callbacks.
 */
import { PublicKeypair, Types, Wallet } from '@stellar/typescript-wallet-sdk';
import { TESTNET } from '@corra/shared';
import { api } from './api';

const CORRIDOR_ISSUER = TESTNET.corridorIssuer;

const env = (import.meta as any).env ?? {};
export const ANCHOR_DOMAIN: string = env.VITE_ANCHOR_DOMAIN ?? 'localhost:8080';
/** The domain the anchor fetches Corra's stellar.toml from (its SIGNING_KEY co-signs SEP-10). */
const CLIENT_DOMAIN: string = env.VITE_CLIENT_DOMAIN ?? 'host.docker.internal:8787';

const anchor = () =>
  Wallet.TestNet().anchor({ homeDomain: ANCHOR_DOMAIN, allowHttp: ANCHOR_DOMAIN.startsWith('localhost') });

type Sign = (xdr: string) => Promise<string>;

/** Freighter prompt: the SEP-10 challenge. Returns the JWT and its expiry (ms). */
export async function anchorLogin(account: string, sign: Sign): Promise<{ token: string; exp: number }> {
  // The SDK's authenticate() does not await an async signer, so drive challenge -> sign -> token.
  const sep10: any = await anchor().sep10();
  const challenge = await sep10.challenge({ accountKp: PublicKeypair.fromPublicKey(account), clientDomain: CLIENT_DOMAIN });
  const { transaction: coSigned } = await api.clientDomainSign(challenge.transaction);
  const signed = await sign(coSigned);
  // getToken only calls `.toXdr()`, which the browser build of stellar-sdk's Transaction lacks.
  const tok: Types.AuthToken = await sep10.getToken({ toXdr: () => signed });
  const exp = Number(tok.expiresAt) * (Number(tok.expiresAt) < 1e12 ? 1000 : 1);
  return { token: tok.token, exp };
}

export type AnchorQuote = { id: string; expiresAt: number; price: string; sellAmount: string; sellAsset: string };

/**
 * The anchor's SEP-38 firm quote for the cash-in leg: MXN paid by SPEI -> `buyAmount` TESTMXN.
 * Requested here, with the user's own session, and handed to Corra unchanged: Corra never holds
 * the user's anchor session, so it could not request a firm quote for them without custody.
 */
export async function firmQuote(token: string, buyAmount: string): Promise<AnchorQuote> {
  const q = await anchor().sep38(Types.AuthToken.from(token)).requestQuote({
    context: 'sep24',
    sell_asset: 'iso4217:MXN',
    buy_asset: `stellar:TESTMXN:${CORRIDOR_ISSUER}`,
    buy_amount: buyAmount,
    sell_delivery_method: 'SPEI',
    country_code: 'MX',
  } as any);
  return { id: q.id, expiresAt: Date.parse(q.expires_at), price: q.price, sellAmount: q.sell_amount, sellAsset: q.sell_asset };
}

/**
 * Starts a SEP-24 TESTMXN deposit for the signed cap. `memo` (a base64 hash) is SEP-24's own
 * field: the anchor attaches it to its on-chain payment, which is how Corra ties the deposit to
 * exactly one payment. The URL is the anchor's own page.
 */
export async function startDeposit(
  token: string, account: string, amount: string, memo: string, quoteId?: string,
): Promise<{ id: string; url: string }> {
  const dep = await anchor().sep24().deposit({
    assetCode: 'TESTMXN',
    authToken: Types.AuthToken.from(token),
    destinationAccount: account,
    extraFields: { amount, memo, memo_type: 'hash', ...(quoteId ? { quote_id: quoteId } : {}) },
  });
  if (!dep.id || !dep.url) throw new Error('the anchor did not return an interactive deposit');
  return { id: dep.id, url: dep.url };
}
