/**
 * Proves the real cash-in path end to end on testnet, with a Keypair standing in for Freighter:
 *
 *   1. sponsored setup through the orchestrator (0 XLM account + TESTMXN trustline)
 *   2. SEP-10 against the anchor with Corra's client_domain co-signature
 *   3. SEP-24 deposit of TESTMXN, simulated SPEI transfer at the anchor's business server
 *   4. TESTMXN lands in the sender's account; the anchor posts a signed callback to the orchestrator
 *
 * Needs the orchestrator (:8787) and the anchor stack (infra/anchor) running.
 *   pnpm anchor-check
 */
import * as S from '@stellar/stellar-sdk';
import { PublicKeypair, Wallet } from '@stellar/typescript-wallet-sdk';
import { TESTNET } from '../packages/shared/src/testnet';

const ORCH = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8787';
const ANCHOR_DOMAIN = process.env.ANCHOR_DOMAIN ?? 'localhost:8080';
const BUSINESS = process.env.ANCHOR_BUSINESS_URL ?? 'http://localhost:8091';
const CLIENT_DOMAIN = process.env.CORRA_CLIENT_DOMAIN ?? 'host.docker.internal:8787';
const AMOUNT = '100';
const NP = TESTNET.networkPassphrase;
const horizon = new S.Horizon.Server(TESTNET.horizonUrl);
const link = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;

async function post(url: string, body: object) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`POST ${url} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}

/** What Freighter does in the app: sign an XDR with the user's key, asynchronously. */
const freighterSign = async (xdr: string, user: S.Keypair) => {
  const tx = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
  tx.sign(user);
  return tx.toXDR();
};

async function main() {
  const user = S.Keypair.random();
  console.log(`sender ${user.publicKey()}`);

  const { xdr } = await post(`${ORCH}/setup`, { account: user.publicKey(), trust: ['MXN'] });
  const setup = S.TransactionBuilder.fromXDR(await freighterSign(xdr, user), NP);
  console.log(`1. sponsored setup ${link((await horizon.submitTransaction(setup)).hash)}`);

  const wallet = Wallet.TestNet();
  const anchor = wallet.anchor({ homeDomain: ANCHOR_DOMAIN, allowHttp: ANCHOR_DOMAIN.startsWith('localhost') });
  const sep10: any = await anchor.sep10();
  // authenticate() does not await an async signer, so drive challenge -> sign -> token explicitly.
  const ch = await sep10.challenge({ accountKp: PublicKeypair.fromPublicKey(user.publicKey()), clientDomain: CLIENT_DOMAIN });
  const { transaction: coSigned } = await post(`${ORCH}/sep10/client-domain`, { transaction: ch.transaction });
  const token = await sep10.getToken(S.TransactionBuilder.fromXDR(await freighterSign(coSigned, user), NP));
  const claims = JSON.parse(Buffer.from(token.token.split('.')[1], 'base64url').toString());
  console.log(`2. SEP-10 JWT sub=${claims.sub} client_domain=${claims.client_domain}`);
  if (claims.client_domain !== CLIENT_DOMAIN) throw new Error('JWT is not attributed to Corra');

  const sep24 = anchor.sep24();
  const dep = await sep24.deposit({ assetCode: 'TESTMXN', authToken: token, extraFields: { amount: AMOUNT } });
  if (!dep.url) throw new Error('the anchor returned no interactive URL');
  const interactiveToken = new URL(dep.url).searchParams.get('token')!;
  console.log(`3. SEP-24 deposit ${dep.id}\n   interactive ${dep.url.split('?')[0]}`);

  const sim = await post(`${BUSINESS}/sep24/simulate`, { token: interactiveToken, amount: AMOUNT });
  console.log(`   simulated SPEI -> anchor paid ${link(sim.stellar_transaction_id)}`);

  for (let i = 0; i < 30; i++) {
    const t = await sep24.getTransactionBy({ authToken: token, id: dep.id });
    if (t.status === 'completed' || t.status === 'error') {
      console.log(`4. SEP-24 status ${t.status}`);
      if (t.status !== 'completed') throw new Error(JSON.stringify(t));
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const acct = await horizon.loadAccount(user.publicKey());
  const bal = acct.balances.find((b: any) => b.asset_code === 'TESTMXN' && b.asset_issuer === TESTNET.corridorIssuer);
  console.log(`   sender TESTMXN ${bal?.balance}, XLM ${acct.balances.find((b: any) => b.asset_type === 'native')?.balance}`);
  if (!bal || Number(bal.balance) < Number(AMOUNT)) throw new Error('TESTMXN did not arrive');
  console.log(`\nCASH-IN OK. Signed callbacks for ${dep.id} are logged by the orchestrator at POST /callbacks/sep24.`);
}

main().catch((e) => {
  console.error('FAILED:', e?.response?.data ?? e.message ?? e);
  process.exit(1);
});
