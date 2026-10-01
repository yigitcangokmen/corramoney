import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { horizon, USDC, USDC_ISSUER, DIST_SECRET, DIST_PUBLIC, NETWORK_PASSPHRASE, fundWithFriendbot } from './stellar';
import type { Ctl } from './types';

export function depGo(ctl: Ctl) {
  if (ctl.state.walletMode === 'none') return;
  const a = ctl.amt('depDigits');
  ctl.set({ depStep:'waiting', depRef:1000 + Math.floor(Math.random() * 8999) });
  ctl.log({ kind:'MXN deposit', state:'Awaiting transfer', tone:0,
    inAmt:'MX$' + ctl.n(a, 2), outAmt:'—', when:ctl.stamp(), tx:null });
}

export async function depSim(ctl: Ctl) {
  if (ctl.state.depStep === 'clearing') return;
  ctl.set({ depStep:'clearing', depProg:0 });
  try {
    ctl.set({ depProg:10 });
    const a = ctl.amt('depDigits');
    const userPub = ctl.state.pubkey!;

    let acct: any;
    try {
      acct = await horizon.loadAccount(userPub);
    } catch {
      await fundWithFriendbot(userPub);
      acct = await horizon.loadAccount(userPub);
    }
    ctl.set({ depProg:20 });
    const hasTrust = acct.balances.some((b: any) =>
      b.asset_type !== 'native' && b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER);
    if (!hasTrust) {
      const ttx = new StellarSdk.TransactionBuilder(acct, {
        fee:'100', networkPassphrase:NETWORK_PASSPHRASE
      }).addOperation(StellarSdk.Operation.changeTrust({ asset:USDC }))
        .setTimeout(30).build();
      const sr = await signTransaction(ttx.toXDR(), { networkPassphrase:NETWORK_PASSPHRASE });
      if (sr.error) throw new Error(sr.error);
      const signed = StellarSdk.TransactionBuilder.fromXDR(sr.signedTxXdr, NETWORK_PASSPHRASE);
      await horizon.submitTransaction(signed as any);
    }

    ctl.set({ depProg:50 });
    const credited = ctl.usdc(a).toFixed(7);
    const distAcct = await horizon.loadAccount(DIST_PUBLIC);
    const payTx = new StellarSdk.TransactionBuilder(distAcct, {
      fee:'100', networkPassphrase:NETWORK_PASSPHRASE
    }).addOperation(StellarSdk.Operation.payment({
      destination:userPub, asset:USDC, amount:credited
    })).setTimeout(30).build();
    payTx.sign(StellarSdk.Keypair.fromSecret(DIST_SECRET));
    const result = await horizon.submitTransaction(payTx);
    const txHash = result.hash || '';

    ctl.set({ depProg:80 });
    await ctl.refreshBalances();
    ctl.set((st: any) => ({
      depProg:100, depStep:'done',
      history: [{ kind:'MXN deposit', state:'Completed', tone:1,
        inAmt:'MX$' + ctl.n(a, 2), outAmt:ctl.n(parseFloat(credited), 4) + ' USDC',
        when:ctl.stamp(), tx:txHash }].concat(st.history.slice(1)).slice(0, 12)
    }));
  } catch(e) {
    console.error('Deposit failed:', e);
    ctl.set({ depStep:'form' });
  }
}
