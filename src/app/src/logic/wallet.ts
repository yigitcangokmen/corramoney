import { isConnected, requestAccess } from '@stellar/freighter-api';
import { getBalances } from './stellar';
import { loadPositions } from './earn';
import type { Ctl } from './types';

export async function connect(ctl: Ctl) {
  if (ctl.state.connecting) return;
  ctl.set({ connecting:true });
  try {
    const { isConnected: connected } = await isConnected();
    if (!connected) {
      ctl.set({ connecting:false });
      window.open('https://freighter.app', '_blank');
      return;
    }
    const r = await requestAccess();
    if (r.error) throw new Error(r.error);
    const pk = r.address;
    if (!ctl.state.connecting) return;
    const b = await getBalances(pk);
    const usdc = parseFloat(b.USDC || '0');
    if (!ctl.state.connecting) return;
    const pos = loadPositions(pk);
    ctl.set({ walletMode:'freighter', pubkey:pk, connecting:false, wallet:usdc, pos });
  } catch(e) {
    console.error('Connect failed:', e);
    if (ctl.state.connecting) ctl.set({ connecting:false });
  }
}

export function disconnect(ctl: Ctl) {
  ctl.set({ walletMode:'none', pubkey:null, wallet:0, connecting:false, pos:{} });
}

export async function refreshBalances(ctl: Ctl) {
  if (!ctl.state.pubkey) return;
  const b = await getBalances(ctl.state.pubkey);
  const usdc = parseFloat(b.USDC || '0');
  ctl.set({ wallet:usdc });
}
