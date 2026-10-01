import * as StellarSdk from '@stellar/stellar-sdk';
import { horizon, USDC, NETWORK_PASSPHRASE, fundWithFriendbot, getBalances } from './stellar';
import type { Ctl } from './types';

export async function connect(ctl: Ctl) {
  if (ctl.state.connecting) return;
  if (typeof window !== 'undefined' && window.freighterApi) {
    return connectFreighter(ctl);
  }
  return connectDemo(ctl);
}

async function connectDemo(ctl: Ctl) {
  ctl.set({ connecting:true });
  try {
    const kp = StellarSdk.Keypair.random();
    await fundWithFriendbot(kp.publicKey());
    const acct = await horizon.loadAccount(kp.publicKey());
    const tx = new StellarSdk.TransactionBuilder(acct, {
      fee:'100', networkPassphrase:NETWORK_PASSPHRASE
    }).addOperation(StellarSdk.Operation.changeTrust({ asset:USDC }))
      .setTimeout(30).build();
    tx.sign(kp);
    await horizon.submitTransaction(tx);
    if (!ctl.state.connecting) return;
    ctl.set({
      walletMode:'demo', pubkey:kp.publicKey(), secretKey:kp.secret(),
      connecting:false, wallet:0
    });
    await refreshBalances(ctl);
  } catch(e) {
    console.error('Connect failed:', e);
    if (ctl.state.connecting) ctl.set({ connecting:false });
  }
}

async function connectFreighter(ctl: Ctl) {
  ctl.set({ connecting:true });
  try {
    const r = await window.freighterApi!.requestAccess();
    const pk = typeof r === 'string' ? r : r.address;
    if (!ctl.state.connecting) return;
    ctl.set({ walletMode:'freighter', pubkey:pk, connecting:false });
    await refreshBalances(ctl);
  } catch(e) {
    console.error('Connect failed:', e);
    if (ctl.state.connecting) ctl.set({ connecting:false });
  }
}

export function disconnect(ctl: Ctl) {
  ctl.set({ walletMode:'none', pubkey:null, secretKey:null, wallet:0, connecting:false });
}

export async function refreshBalances(ctl: Ctl) {
  if (!ctl.state.pubkey) return;
  const b = await getBalances(ctl.state.pubkey);
  const usdc = parseFloat(b.USDC || '0');
  ctl.set({ wallet:usdc });
}
