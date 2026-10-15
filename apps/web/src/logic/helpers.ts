import { CORR } from './data';
import type { Ctl } from './types';

export function n(ctl: Ctl, v: number, d: number) { return v.toLocaleString('en-US',
  { minimumFractionDigits:d, maximumFractionDigits:d }); }

export function amt(ctl: Ctl, k: string) { return parseInt((ctl.state as any)[k] || '0', 10) || 0; }

export function usdc(ctl: Ctl, mxn: number) { return mxn / ctl.rate; }

export function corr(ctl: Ctl) { return CORR.find(c => c.iso === ctl.state.pick) || CORR[0]; }

export function log(ctl: Ctl, entry: any) { ctl.set(s => ({ history:[entry].concat(s.history).slice(0, 12) })); }

export function stamp(ctl: Ctl) {
  const d = new Date();
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) +
    ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

export function hash(ctl: Ctl) { return Math.random().toString(16).slice(2, 12); }
