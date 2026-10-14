import { isConnected, requestAccess } from '@stellar/freighter-api';
import { getBalances } from './stellar';
import { loadPositions } from './earn';
import { assertFreighterReady, cancelRemit, freighterMessage, freighterSign } from './remit';
import type { Ctl } from './types';

export async function connect(ctl: Ctl) {
  if (ctl.state.connecting) return;
  ctl.set({ connecting:true, remitError:null, freighterMissing:false });
  try {
    const { isConnected: connected } = await isConnected();
    if (!connected) {
      // No window.open here: after an await the browser blocks it. The UI shows an install link.
      ctl.set({ connecting:false, freighterMissing:true });
      return;
    }
    const r = await requestAccess();
    if (r.error) throw new Error(freighterMessage(r.error));
    const pk = r.address;
    if (!ctl.state.connecting) return;
    await assertFreighterReady();
    // Freighter remembers a site it already allowed and stops prompting, so connecting is the
    // anchor login itself: a SEP-10 challenge signed in the wallet on every connect. It is never
    // submitted and moves nothing; the anchor verifies it and issues the session used for cash-in.
    ctl.set({ remitBusy:'Freighter: sign in to the anchor (SEP-10). Never submitted, moves no money.' });
    const { anchorLogin } = await import('./anchor');
    const { token, exp } = await anchorLogin(pk, (xdr) => freighterSign(xdr, pk));
    const b = await getBalances(pk);
    const mxn = parseFloat(b.TESTMXN || '0');
    if (!ctl.state.connecting) return;
    const pos = loadPositions(pk);
    ctl.set({ walletMode:'freighter', pubkey:pk, connecting:false, wallet:mxn, pos,
      anchorToken:token, anchorTokenExp:exp, remitBusy:null });
  } catch(e) {
    // Usually the user's own doing (rejected, wrong network); the message is on screen.
    console.warn('Connect failed:', e);
    ctl.set({ connecting:false, remitBusy:null,
      remitError:'Not connected: ' + (e instanceof Error ? e.message : String(e)) });
  }
}

export function disconnect(ctl: Ctl) {
  cancelRemit();
  ctl.set({ walletMode:'none', pubkey:null, wallet:0, connecting:false, pos:{},
    anchorToken:null, anchorTokenExp:0, setupDone:false, quote:null, anchorQuote:null, payment:null,
    remitStep:'form', remitBusy:null, remitError:null, cashInUrl:null,
    trackError:null, popupBlocked:false, depositSkipped:false });
}

export async function refreshBalances(ctl: Ctl) {
  if (!ctl.state.pubkey) return;
  const b = await getBalances(ctl.state.pubkey);
  ctl.set({ wallet:parseFloat(b.TESTMXN || '0') });
}
