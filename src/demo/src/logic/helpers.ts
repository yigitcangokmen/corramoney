import { VAULTS, CORR } from './data';
import type { Ctl, Position } from './types';

export function earnedOf(p: Position, apy: number) {
  return p.amt * (apy / 100) / 31536000 * ((Date.now() - p.at) / 1000);
}

export function n(ctl: Ctl, v: number, d: number) { return v.toLocaleString('en-US',
  { minimumFractionDigits:d, maximumFractionDigits:d }); }

export function amt(ctl: Ctl, k: string) { return parseInt(ctl.state[k] || '0', 10) || 0; }

export function usdc(ctl: Ctl, try_: number) { return try_ / ctl.rate; }

export function corr(ctl: Ctl) { return CORR.find(c => c.iso === ctl.state.pick) || CORR[0]; }

export function pickedVault(ctl: Ctl) { return VAULTS.find(v => v.id === ctl.state.vaultPick) || VAULTS[0]; }

export function totalVault(ctl: Ctl) { return Object.keys(ctl.state.pos)
  .reduce((n, id) => n + ctl.state.pos[id].amt, 0); }

export function totalEarned(ctl: Ctl) {
  return Object.keys(ctl.state.pos).reduce((n: number, id: string) => {
    const v = VAULTS.find(x => x.id === id);
    return n + (v ? earnedOf(ctl.state.pos[id], v.apy) : 0);
  }, 0);
}

export function log(ctl: Ctl, entry: any) { ctl.set(s => ({ history:[entry].concat(s.history).slice(0, 12) })); }

export function stamp(ctl: Ctl) {
  const d = new Date();
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) +
    ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

export function hash(ctl: Ctl) { return Math.random().toString(16).slice(2, 12); }
