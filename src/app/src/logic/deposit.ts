import type { Ctl } from './types';

export function depGo(ctl: Ctl) {
  const a = ctl.amt('depDigits');
  ctl.set({ depStep:'waiting', depRef:1000 + Math.floor(Math.random() * 8999) });
  ctl.log({ kind:'TRY deposit', state:'Awaiting transfer', tone:0,
    inAmt:'\u20BA' + ctl.n(a, 2), outAmt:'\u2014', when:ctl.stamp(), tx:null });
}

export function depSim(ctl: Ctl) {
  ctl.set({ depStep:'clearing', depProg:0 });
  clearInterval(ctl.run);
  ctl.run = setInterval(() => {
    const p = Math.min(100, (ctl.state.depProg || 0) + 7);
    if (p < 100){ ctl.set({ depProg:p }); return; }
    clearInterval(ctl.run);
    const a = ctl.amt('depDigits'), got = ctl.usdc(a);
    ctl.set(st => ({
      depProg:100, depStep:'done', wallet: st.wallet + got,
      history: [{ kind:'TRY deposit', state:'Completed', tone:1,
        inAmt:'\u20BA' + ctl.n(a, 2), outAmt:ctl.n(got, 4) + ' USDC',
        when:ctl.stamp(), tx:ctl.hash() }].concat(st.history.slice(1)).slice(0, 12)
    }));
  }, 100);
}
