import { TRACK } from './data';
import type { Ctl } from './types';

export function sndSign(ctl: Ctl) {
  const a = ctl.amt('sndDigits'), c = ctl.corr();
  const out = ctl.usdc(a) * (1 - ctl.spread) * c.rate;
  ctl.set({ sendStep:3, saga:ctl.hash().slice(0, 8) });
  ctl.ask({
    title:'Send to ' + c.name, op:'strict-receive path payment',
    dest:ctl.state.addr.slice(0, 6) + '\u2026' + ctl.state.addr.slice(-6),
    amt:ctl.n(ctl.usdc(a), 2) + ' USDC \u2192 ' + c.sym + ctl.n(out, 2),
    run: () => ctl.sndSim(),
    cancel: () => ctl.set({ sendStep:2 })
  });
}

export function sndSim(ctl: Ctl) {
  ctl.set({ sendStep:4, elapsed:0, trackProg:0 });
  clearInterval(ctl.trk);
  ctl.trk = setInterval(() => {
    const p = Math.min(100, (ctl.state.trackProg || 0) + 4);
    if (p < 100){ ctl.set({ trackProg:p, elapsed:+(p * 0.052).toFixed(1) }); return; }
    clearInterval(ctl.trk);
    const a = ctl.amt('sndDigits'), c = ctl.corr();
    const out = ctl.usdc(a) * (1 - ctl.spread) * c.rate;
    const tx = ctl.hash();
    ctl.set(st => ({
      trackProg:100, elapsed:5.2, sendStep:5,
      txHash:tx, ledger:1284000 + Math.floor(Math.random() * 900),
      wallet: Math.max(0, st.wallet - ctl.usdc(a)),
      history: [{ kind:'Transfer \u00B7 ' + c.cur, state:'Completed', tone:1,
        inAmt:'\u20BA' + ctl.n(a, 2), outAmt:c.sym + ctl.n(out, 2),
        when:ctl.stamp(), tx:tx }].concat(st.history).slice(0, 12)
    }));
  }, 110);
}
