/**
 * Creates a public demo recipient that holds a trustline for every destination asset, so a
 * reviewer can send without setting up a second wallet. Its secret is discarded: it only
 * ever receives. Writes its address into packages/shared/src/testnet.ts.
 *
 * Usage: pnpm demo-recipient
 */
import * as S from '@stellar/stellar-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { DEST_FIATS, FIAT } from '../packages/shared/src/corridors';
import { TESTNET } from '../packages/shared/src/testnet';

const TESTNET_TS = 'packages/shared/src/testnet.ts';

async function main() {
  const horizon = new S.Horizon.Server(TESTNET.horizonUrl);
  const kp = S.Keypair.random();
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);

  const acct = await horizon.loadAccount(kp.publicKey());
  const b = new S.TransactionBuilder(acct, { fee: '1000', networkPassphrase: TESTNET.networkPassphrase }).setTimeout(60);
  for (const f of DEST_FIATS) b.addOperation(S.Operation.changeTrust({ asset: new S.Asset(FIAT[f].code, TESTNET.corridorIssuer) }));
  const tx = b.build();
  tx.sign(kp);
  const res = await horizon.submitTransaction(tx);
  console.log(`demo recipient ${kp.publicKey()}\ntrustlines https://stellar.expert/explorer/testnet/tx/${res.hash}`);

  const src = readFileSync(TESTNET_TS, 'utf8');
  const line = `  demoRecipient: '${kp.publicKey()}',\n`;
  const next = /  demoRecipient: '[A-Z0-9]+',\n/.test(src)
    ? src.replace(/  demoRecipient: '[A-Z0-9]+',\n/, line)
    : src.replace(/(  clientDomainSigner: '[A-Z0-9]+',\n)/, `$1${line}`);
  writeFileSync(TESTNET_TS, next);
  console.log(`wrote demoRecipient to ${TESTNET_TS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
