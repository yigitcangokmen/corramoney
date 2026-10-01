import { horizon, getBalances } from './stellar';
import type { Ctl } from './types';

export async function connect(ctl: Ctl) {
  if (ctl.state.connecting) return;
  if (typeof window !== 'undefined' && window.freighterApi) {
    return connectFreighter(ctl);
  }
  window.open('https://freighter.app', '_blank');
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
  ctl.set({ walletMode:'none', pubkey:null, wallet:0, connecting:false });
}

export async function refreshBalances(ctl: Ctl) {
  if (!ctl.state.pubkey) return;
  const b = await getBalances(ctl.state.pubkey);
  const usdc = parseFloat(b.USDC || '0');
  ctl.set({ wallet:usdc });
}
