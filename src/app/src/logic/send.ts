import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { horizon, USDC, USDC_ISSUER, DIST_PUBLIC, NETWORK_PASSPHRASE } from './stellar';
import type { Ctl } from './types';

export function sndSign(ctl: Ctl) {
  ctl.set({ saga:ctl.hash().slice(0, 8) });
  sndReal(ctl);
}

async function sndReal(ctl: Ctl) {
  ctl.set({ sendStep:4, elapsed:0, trackProg:0 });
  const startMs = Date.now();
  const tick = () => {
    const el = (Date.now() - startMs) / 1000;
    ctl.set({ elapsed:+el.toFixed(1) });
  };
  ctl.trk = setInterval(tick, 100);
  try {
    ctl.set({ trackProg:10 });
    const a = ctl.amt('sndDigits'), c = ctl.corr();
    const usdcAmt = ctl.usdc(a);

    ctl.set({ trackProg:25 });
    let destAccount: any;
    try {
      destAccount = await horizon.loadAccount(ctl.state.addr);
    } catch {
      throw new Error('Recipient account not found on Stellar testnet');
    }

    const hasUsdcTrust = destAccount.balances.some((b: any) =>
      b.asset_type !== 'native' && b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER);

    ctl.set({ trackProg:40 });
    const acct = await horizon.loadAccount(ctl.state.pubkey!);
    let tx: StellarSdk.Transaction;
    let sendMode: 'usdc' | 'xlm' = 'xlm';

    if (hasUsdcTrust) {
      sendMode = 'usdc';
      const sendAmt = (usdcAmt * (1 - ctl.spread)).toFixed(7);
      tx = new StellarSdk.TransactionBuilder(acct, {
        fee:'100', networkPassphrase:NETWORK_PASSPHRASE
      }).addOperation(StellarSdk.Operation.payment({
        destination:ctl.state.addr, asset:USDC, amount:sendAmt
      })).setTimeout(1800).build();
    } else {
      sendMode = 'xlm';
      const xlmAmt = (usdcAmt * (1 - ctl.spread)).toFixed(7);
      const usdcBurn = (usdcAmt * (1 - ctl.spread)).toFixed(7);
      tx = new StellarSdk.TransactionBuilder(acct, {
        fee:'200', networkPassphrase:NETWORK_PASSPHRASE
      }).addOperation(StellarSdk.Operation.payment({
        destination:DIST_PUBLIC, asset:USDC, amount:usdcBurn
      })).addOperation(StellarSdk.Operation.payment({
        destination:ctl.state.addr, asset:StellarSdk.Asset.native(), amount:xlmAmt
      })).setTimeout(1800).build();
    }

    ctl.set({ trackProg:55 });
    const sr = await signTransaction(tx.toXDR(), { networkPassphrase:NETWORK_PASSPHRASE });
    if (sr.error) throw new Error(sr.error);
    const signedTx = StellarSdk.TransactionBuilder.fromXDR(sr.signedTxXdr, NETWORK_PASSPHRASE);

    ctl.set({ trackProg:75 });
    const result = await horizon.submitTransaction(signedTx as any);
    const txHash = result.hash || (result as any).id || '';
    const ledger = result.ledger || 0;

    clearInterval(ctl.trk);
    if (ctl.state.sendStep !== 4) return;
    const elapsed = +((Date.now() - startMs) / 1000).toFixed(1);
    const outLabel = sendMode === 'usdc'
      ? ctl.n(usdcAmt * (1 - ctl.spread), 2) + ' USDC'
      : ctl.n(usdcAmt * (1 - ctl.spread), 4) + ' XLM';
    const kindLabel = sendMode === 'usdc' ? 'USDC' : 'XLM';
    ctl.set((st: any) => ({
      trackProg:100, elapsed, sendStep:5, txHash, ledger,
      history: [{ kind:'Transfer · ' + kindLabel, state:'Completed', tone:1,
        inAmt:'MX$' + ctl.n(a, 2), outAmt:outLabel,
        when:ctl.stamp(), tx:txHash }].concat(st.history).slice(0, 12)
    }));
  } catch(e: any) {
    clearInterval(ctl.trk);
    if (ctl.state.sendStep !== 4) return;
    console.error('Send failed:', e);
    const errMsg = e.response?.data?.extras?.result_codes?.operations?.[0] || e.message || 'Unknown error';
    ctl.set((st: any) => ({
      sendStep:5, trackProg:100,
      txHash:'FAILED: ' + errMsg, ledger:0,
      history: [{ kind:'Transfer (failed)', state:'Failed', tone:0,
        inAmt:'MX$' + ctl.n(ctl.amt('sndDigits'), 2), outAmt:errMsg,
        when:ctl.stamp(), tx:null }].concat(st.history).slice(0, 12)
    }));
  }
  ctl.refreshBalances().catch(() => {});
}
