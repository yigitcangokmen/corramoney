import type { Ctl } from './types';

export function ask(ctl: Ctl, sign: any) { ctl.set({ sign:sign, signState:'ask' }); }

export function signReject(ctl: Ctl) {
  const sg = ctl.state.sign;
  ctl.set({ sign:null, signState:'ask' });
  if (sg && sg.cancel) sg.cancel();
}

export function signGo(ctl: Ctl) {
  const sg = ctl.state.sign;
  if (!sg) return;
  ctl.set({ signState:'busy' });
  setTimeout(() => { ctl.set({ sign:null, signState:'ask' }); sg.run(); }, 1500);
}
