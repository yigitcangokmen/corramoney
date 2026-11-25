/**
 * Adds the TESTPHP trustline to the anchor's distribution account, so the anchor can receive
 * SEP-24 withdrawals of TESTPHP. Signed with the anchor's own distribution key from .env.testnet;
 * never printed. Safe to rerun: prints "already trusted" when the line exists.
 * New seed runs add it in step 2 (seed-testnet.ts); this is for the accounts seeded before that.
 * Stellar TESTNET only. Local and production share this account, so the line serves both.
 *
 *   pnpm anchor-trustline
 */
import * as S from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { fiatAsset, TESTNET } from '../packages/shared/src';

const horizon = new S.Horizon.Server(TESTNET.horizonUrl);

const env = Object.fromEntries(
  readFileSync('.env.testnet', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

async function main() {
  if (!env.ANCHOR_DISTRIBUTION_SECRET) throw new Error('.env.testnet has no ANCHOR_DISTRIBUTION_SECRET');
  const distribution = S.Keypair.fromSecret(env.ANCHOR_DISTRIBUTION_SECRET);
  if (distribution.publicKey() !== TESTNET.anchorDistribution) {
    throw new Error('.env.testnet and packages/shared/src/testnet.ts are from different seed runs');
  }
  const php = fiatAsset('PHP');
  const acct = await horizon.loadAccount(distribution.publicKey());
  if (acct.balances.some((b: any) => b.asset_code === php.code && b.asset_issuer === php.issuer)) {
    console.log(`already trusted: ${distribution.publicKey()} holds a ${php.code} line from ${php.issuer}`);
    return;
  }
  const tx = new S.TransactionBuilder(acct, { fee: '1000', networkPassphrase: TESTNET.networkPassphrase })
    .addOperation(S.Operation.changeTrust({ asset: new S.Asset(php.code, php.issuer!) }))
    .setTimeout(60)
    .build();
  tx.sign(distribution);
  const r = await horizon.submitTransaction(tx);
  console.log(`TESTPHP trustline added to ${distribution.publicKey()}\n  https://stellar.expert/explorer/testnet/tx/${r.hash}`);
}

main().catch((e) => {
  console.error('FAILED:', e?.response?.data?.extras?.result_codes ?? e.message ?? e);
  process.exit(1);
});
