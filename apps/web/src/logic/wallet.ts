import { isConnected, requestAccess } from '@stellar/freighter-api';
import { readAccount, type AccountView } from './stellar';
import { track } from './analytics';
import { assertFreighterReady, cancelRemit, freighterMessage, freighterSign } from './remit';
import * as deposit from './deposit';
import * as pool from './pool';
import * as cashout from './cashout';
import type { Ctl } from './types';

/** The balance fields of a Horizon read. */
const balanceFields = (v: AccountView) => ({
  wallet: parseFloat(v.testmxn), walletSpendable: v.spendable, setupDone: v.exists && v.mxnTrusted && !!v.paymentAccount,
  mxnTrusted: v.exists && v.mxnTrusted, paymentAccount: v.paymentAccount,
  phpTrusted: v.exists && v.phpTrusted, phpSpendable: v.phpSpendable,
  otherBalances: v.others, balanceAt: Date.now(),
});

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
    const triedAt = Date.now();
    const v = await readAccount(pk);
    if (!ctl.state.connecting) return;
    ctl.set({ walletMode:'freighter', pubkey:pk, connecting:false,
      ...(v ? balanceFields(v) : { wallet:0, balanceAt:0 }), balanceTriedAt:triedAt, balanceFails: v ? 0 : 1,
      anchorToken:token, anchorTokenExp:exp, remitBusy:null });
    track('wallet-connect');
    // Deposits started before a reload: report lost anchor refs, then pick up a waiting one.
    deposit.relinkRemembered(ctl).then(() => deposit.resumeDeposit(ctl)).catch(() => {});
    // A cash-out started before a reload: back to waiting for the anchor, or to its on-chain payment.
    cashout.resumeCashOut(ctl).catch(() => {});
  } catch(e) {
    // Usually the user's own doing (rejected, wrong network); the message is on screen.
    console.warn('Connect failed:', e);
    ctl.set({ connecting:false, remitBusy:null,
      remitError:'Not connected: ' + (e instanceof Error ? e.message : String(e)) });
  }
}

export function disconnect(ctl: Ctl) {
  cancelRemit();
  deposit.cancelDeposit();
  pool.cancelPool();
  cashout.cancelCashOut();
  ctl.set({ walletMode:'none', pubkey:null, wallet:0, connecting:false,
    anchorToken:null, anchorTokenExp:0, setupDone:false, mxnTrusted:false, paymentAccount:null, quote:null, anchorQuote:null, payment:null,
    remitStep:'form', remitBusy:null, remitError:null, cashInUrl:null,
    trackError:null, popupBlocked:false, depositSkipped:false,
    payFrom:'anchor', walletSpendable:'0', otherBalances:{}, balanceAt:0, balanceTriedAt:0, balanceFails:0, signedWaiting:false,
    depositStep:'form', depositAmount:'', deposit:null, depositUrl:null, depositUrlAt:0, depositBusy:null,
    depositError:null, depositPopupBlocked:false,
    poolRead:'idle', pool:null, poolReadAt:0, poolReadError:null, poolAmount:'', poolStep:'form', poolBusy:null,
    poolError:null, poolDone:null,
    phpTrusted:false, phpSpendable:'0', cashOutRead:'idle', cashOutRows:[], cashOutActive:null, cashOutBusy:null,
    cashOutError:null, cashOutPopupBlocked:false,
    // The Cash out tab is hidden when disconnected: leave it for Send.
    ...(ctl.state.tab === 'cashout' ? { tab:'send' as const } : {}) });
}

/**
 * A Horizon blip (null) leaves the last known values on screen and counts a failed read, so the
 * Balance card says Horizon is not answering only after several in a row. The payment account
 * already known is read directly instead of walking the ?signer= listing.
 */
export async function refreshBalances(ctl: Ctl) {
  const pk = ctl.state.pubkey;
  if (!pk) return;
  const v = await readAccount(pk, ctl.state.paymentAccount);
  // A refresh only raises setupDone and never forgets a known payment account: a lagging Horizon
  // replica right after setup must not undo it (a merged one is found when a payment reads it).
  if (ctl.state.pubkey === pk) {
    ctl.set(v ? { ...balanceFields(v), setupDone: ctl.state.setupDone || (v.exists && v.mxnTrusted && !!v.paymentAccount),
      mxnTrusted: ctl.state.mxnTrusted || (v.exists && v.mxnTrusted),
      phpTrusted: ctl.state.phpTrusted || (v.exists && v.phpTrusted),
      paymentAccount: v.paymentAccount ?? ctl.state.paymentAccount, balanceFails: 0 } : { balanceFails: ctl.state.balanceFails + 1 });
  }
}
