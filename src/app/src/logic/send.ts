import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { horizon, USDC, CORRIDOR_ISSUER, NETWORK_PASSPHRASE } from './stellar';
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
    const destAsset = new StellarSdk.Asset(c.cur, CORRIDOR_ISSUER);
    const estDest = (usdcAmt * c.rate * (1 - ctl.spread)).toFixed(7);

    ctl.set({ trackProg:25 });
    let destAmount = estDest;
    try {
      const paths = await horizon.strictReceivePaths(
        [USDC], destAsset, estDest).call();
      if (paths.records.length > 0) {
        destAmount = paths.records[0].destination_amount;
      }
    } catch(e) { console.warn('Path check failed, using estimate:', e); }

    ctl.set({ trackProg:40 });
    const acct = await horizon.loadAccount(ctl.state.pubkey!);
    const sendMax = (usdcAmt * 1.05).toFixed(7);
    const tx = new StellarSdk.TransactionBuilder(acct, {
      fee:'100', networkPassphrase:NETWORK_PASSPHRASE
    }).addOperation(StellarSdk.Operation.pathPaymentStrictReceive({
      sendAsset:USDC, sendMax:sendMax,
      destination:ctl.state.addr, destAsset:destAsset,
      destAmount:destAmount
    })).setTimeout(1800).build();

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
    const out = usdcAmt * (1 - ctl.spread) * c.rate;
    ctl.set((st: any) => ({
      trackProg:100, elapsed:elapsed, sendStep:5,
      txHash:txHash, ledger:ledger,
      history: [{ kind:'Transfer · ' + c.cur, state:'Completed', tone:1,
        inAmt:'MX$' + ctl.n(a, 2), outAmt:c.sym + ctl.n(out, 2),
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
