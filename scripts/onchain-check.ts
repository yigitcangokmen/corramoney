/**
 * Drives the Deliverable 1 mechanics end to end on testnet, with keypairs standing in for
 * Freighter. Prints every transaction hash so the run is verifiable on stellar.expert.
 *
 *   1. sponsored setup: sender and recipient created with 0 XLM, trustlines sponsored (CAP-33)
 *   2. sender signs the strict-receive payment BEFORE holding any TESTMXN
 *   3. simulated cash-in credits the sender, confirmed from chain state
 *   4. the signed blob is fee-bumped (CAP-15) and submitted: recipient credited
 *   5. failure paths: sendMax too low -> cap exceeded; maxTime passed -> expired
 *
 * Usage: pnpm onchain-check
 */
import * as S from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { fiatAsset, fromDecimal, TESTNET, toDecimal, withSlippage, type Money } from '../packages/shared/src';
import {
  assertBoundPayment,
  buildSponsoredSetup,
  buildStrictReceive,
  createHorizonGateway,
  createSponsor,
} from '../packages/stellar/src';

const env = Object.fromEntries(
  readFileSync('.env.testnet', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const NP = TESTNET.networkPassphrase;
const horizon = new S.Horizon.Server(TESTNET.horizonUrl);
const sponsor = createSponsor(env.FEE_SPONSOR_SECRET, NP, { trustIssuer: TESTNET.corridorIssuer, trustCodes: ['TESTMXN', 'TESTPHP'] });
const gateway = createHorizonGateway({ horizonUrl: TESTNET.horizonUrl, networkPassphrase: NP, sponsor });
const anchor = S.Keypair.fromSecret(env.ANCHOR_DISTRIBUTION_SECRET);
const MXN = fiatAsset('MXN');
const PHP = fiatAsset('PHP');
const now = () => Math.floor(Date.now() / 1000);
const link = (h?: string) => (h ? `https://stellar.expert/explorer/testnet/tx/${h}` : '(no hash)');

async function submitXdr(xdr: string) {
  try {
    return await horizon.submitTransaction(S.TransactionBuilder.fromXDR(xdr, NP));
  } catch (e: any) {
    throw new Error(JSON.stringify(e?.response?.data?.extras?.result_codes ?? e.message));
  }
}

async function sponsoredSetup(user: S.Keypair, trust: typeof MXN) {
  const sp = await horizon.loadAccount(sponsor.publicKey);
  const tx = buildSponsoredSetup({
    networkPassphrase: NP, sponsor: sponsor.publicKey, sponsorSequence: sp.sequence,
    account: user.publicKey(), accountExists: false, trust: [trust], now: now(),
  });
  const bySponsor = S.TransactionBuilder.fromXDR(sponsor.signSetup(tx.toXDR()), NP) as S.Transaction;
  bySponsor.sign(user); // Freighter in the app
  return (await submitXdr(bySponsor.toXDR())).hash;
}

async function cashIn(to: string, amount: Money) {
  const a = await horizon.loadAccount(anchor.publicKey());
  const tx = new S.TransactionBuilder(a, { fee: '1000', networkPassphrase: NP })
    .addOperation(S.Operation.payment({ destination: to, asset: new S.Asset(MXN.code, MXN.issuer), amount: toDecimal(amount) }))
    .setTimeout(60).build();
  tx.sign(anchor);
  return (await submitXdr(tx.toXDR())).hash;
}

async function signPayment(sender: S.Keypair, recipient: string, dest: Money, sendMax: Money, path: typeof MXN[], ttlNow = now(), ttlSec?: number) {
  const acct = await horizon.loadAccount(sender.publicKey());
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), senderSequence: acct.sequence,
    recipient, dest, sendMax, path, now: ttlNow, ttlSec,
  });
  tx.sign(sender); // Freighter in the app
  return tx.toXDR();
}

const balance = async (id: string, code: string) => {
  const a = await horizon.loadAccount(id);
  const b = a.balances.find((x: any) => (code === 'XLM' ? x.asset_type === 'native' : x.asset_code === code));
  return b ? b.balance : 'none';
};

async function main() {
  const sender = S.Keypair.random();
  const recipient = S.Keypair.random();
  console.log(`sender    ${sender.publicKey()}\nrecipient ${recipient.publicKey()}\n`);

  console.log('1. sponsored setup (accounts created with 0 XLM)');
  console.log(`   sender    ${link(await sponsoredSetup(sender, MXN))}`);
  console.log(`   recipient ${link(await sponsoredSetup(recipient, PHP))}`);
  console.log(`   sender XLM balance: ${await balance(sender.publicKey(), 'XLM')}`);

  console.log('\n2. quote + sign before cash-in');
  const dest = fromDecimal(PHP, '1000');
  const route = await gateway.findStrictReceivePath({ sourceAsset: MXN, dest });
  if (!route) throw new Error('no route');
  const sendMax = withSlippage(route.source, 150);
  console.log(`   route TESTMXN -> ${route.path.map((p) => p.code).join(' -> ')} -> TESTPHP, cost ${toDecimal(route.source)}, sendMax ${toDecimal(sendMax)}`);
  const signed = await signPayment(sender, recipient.publicKey(), dest, sendMax, route.path);
  const bound = assertBoundPayment(signed, { sender: sender.publicKey(), recipient: recipient.publicKey(), dest, sendMax, path: route.path }, NP, now());
  console.log(`   signed, bound check passed. sender TESTMXN balance now: ${await balance(sender.publicKey(), 'TESTMXN')}`);
  console.log(`   minSeqNum ${bound.minSequence}, seq ${bound.sequence}, maxTime ${new Date(bound.maxTime * 1000).toISOString()}`);

  console.log('\n3. cash-in, confirmed from chain state');
  const since = Date.now() - 5000;
  console.log(`   anchor -> sender ${link(await cashIn(sender.publicKey(), sendMax))}`);
  const dep = await gateway.findDeposit({ account: sender.publicKey(), from: anchor.publicKey(), asset: MXN, since });
  console.log(`   chain confirms deposit: ${dep ? toDecimal(dep.amount) + ' TESTMXN' : 'NOT FOUND'}`);
  if (!dep) throw new Error('deposit not visible on chain');

  console.log('\n4. submit the pre-signed blob, fee-bumped by the sponsor');
  const out = await gateway.submitPayment(signed);
  if (out.kind !== 'success') throw new Error(`payment failed: ${JSON.stringify(out)}`);
  console.log(`   ${link(out.hash)}`);
  console.log(`   recipient TESTPHP: ${await balance(recipient.publicKey(), 'TESTPHP')}   sender XLM: ${await balance(sender.publicKey(), 'XLM')}`);

  console.log('\n5a. cap exceeded: sendMax below the real cost');
  const lowCap = fromDecimal(MXN, toDecimal({ asset: MXN, raw: route.source.raw / 2n }));
  const capBlob = await signPayment(sender, recipient.publicKey(), dest, lowCap, route.path);
  await cashIn(sender.publicKey(), lowCap);
  const cap = await gateway.submitPayment(capBlob);
  console.log(`   outcome: ${cap.kind} ${'hash' in cap ? link(cap.hash) : ''}`);
  console.log(`   codes: ${JSON.stringify((cap as any).codes)}`);
  if (cap.kind !== 'cap_exceeded') throw new Error('expected cap_exceeded');
  console.log(`   recipient TESTPHP unchanged: ${await balance(recipient.publicKey(), 'TESTPHP')}`);

  console.log('\n5b. expired: maxTime already passed');
  const oldBlob = await signPayment(sender, recipient.publicKey(), dest, sendMax, route.path, now() - 120, 60);
  const exp = await gateway.submitPayment(oldBlob);
  console.log(`   outcome: ${exp.kind}  codes: ${JSON.stringify((exp as any).codes)}`);
  if (exp.kind !== 'expired') throw new Error('expected expired');

  console.log('\nALL CHECKS PASSED');
}

main().catch((e) => {
  console.error('\nFAILED:', e.message ?? e);
  process.exit(1);
});
