import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { horizon, USDC, USDC_ISSUER, NETWORK_PASSPHRASE } from './stellar';
import type { Ctl } from './types';

export function depGo(ctl: Ctl) {
  if (ctl.state.walletMode === 'none') return;
  const a = ctl.amt('depDigits');
  ctl.set({ depStep:'waiting', depRef:1000 + Math.floor(Math.random() * 8999) });
  ctl.log({ kind:'MXN deposit', state:'Awaiting transfer', tone:0,
    inAmt:'MX$' + ctl.n(a, 2), outAmt:'—', when:ctl.stamp(), tx:null });
}

export async function depSim(ctl: Ctl) {
  ctl.set({ depStep:'clearing', depProg:0 });
  try {
    ctl.set({ depProg:30 });
    const a = ctl.amt('depDigits');
    const acct = await horizon.loadAccount(ctl.state.pubkey!);
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
    ctl.set({ depProg:60 });
    await ctl.refreshBalances();
    ctl.set((st: any) => ({
      depProg:100, depStep:'done',
      history: [{ kind:'MXN deposit', state:'Completed', tone:1,
        inAmt:'MX$' + ctl.n(a, 2), outAmt:ctl.n(ctl.usdc(a), 4) + ' USDC',
        when:ctl.stamp(), tx:ctl.hash() }].concat(st.history.slice(1)).slice(0, 12)
    }));
  } catch(e) {
    console.error('Deposit failed:', e);
    ctl.set({ depStep:'form' });
  }
}
