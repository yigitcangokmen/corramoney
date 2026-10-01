import { VAULTS } from './data';
import { earnedOf } from './helpers';
import type { Ctl } from './types';

export function vaultGo(ctl: Ctl) {
  const v = parseFloat(ctl.state.vaultDigits) || 0;
  const t = ctl.pickedVault();
  if (v <= 0 || v > ctl.state.wallet) return;
  ctl.ask({
    title:'Deposit into ' + t.name, op:'payment', dest:t.name + ' \u00B7 ' + t.addr,
    amt:ctl.n(v, 2) + ' USDC',
    run: () => {
      ctl.set(st => {
        const cur = st.pos[t.id];
        const pos = Object.assign({}, st.pos);
        // topping up keeps the accrued figure and restarts the clock against
        // the larger principal, so nothing already earned is lost
        pos[t.id] = cur
          ? { amt: cur.amt + v, at: Date.now(), earned: 0 }
          : { amt: v, at: Date.now(), earned: 0 };
        return { pos:pos, wallet: st.wallet - v, vaultDigits:'' };
      });
      ctl.log({ kind:'Vault deposit \u00B7 ' + t.name, state:'Completed', tone:1,
        inAmt:ctl.n(v, 2) + ' USDC', outAmt:ctl.n(v, 2) + ' USDC',
        when:ctl.stamp(), tx:ctl.hash() });
    }
  });
}

export function vaultOut(ctl: Ctl, id: string) {
  const p = ctl.state.pos[id];
  const t = VAULTS.find(v => v.id === id)!;
  if (!p || p.amt <= 0) return;
  const gained = earnedOf(p, t.apy);
  const back = p.amt + gained;
  ctl.ask({
    title:'Withdraw from ' + t.name, op:'payment',
    dest:'Your wallet \u00B7 GAJL\u20262677', amt:ctl.n(back, 7) + ' USDC',
    run: () => {
      ctl.log({ kind:'Vault withdrawal \u00B7 ' + t.name, state:'Completed', tone:1,
        inAmt:ctl.n(p.amt, 2) + ' USDC', outAmt:ctl.n(back, 7) + ' USDC',
        earned:'+' + ctl.n(gained, 7) + ' USDC',
        when:ctl.stamp(), tx:ctl.hash() });
      ctl.set(st => {
        const pos = Object.assign({}, st.pos);
        delete pos[id];
        return { pos:pos, wallet: st.wallet + back };
      });
    }
  });
}

export function cashOut(ctl: Ctl) {
  const w = ctl.state.wallet;
  if (w <= 0) return;
  ctl.ask({
    title:'Send to the anchor', op:'payment',
    dest:'Anchor Bank A.\u015E. \u00B7 GANC\u20264K2Q', amt:ctl.n(w, 2) + ' USDC',
    run: () => {
      ctl.log({ kind:'TRY withdrawal', state:'Awaiting bank', tone:0,
        inAmt:ctl.n(w, 2) + ' USDC', outAmt:'\u20BA' + ctl.n(w * ctl.rate, 2),
        when:ctl.stamp(), tx:ctl.hash() });
      ctl.set({ wallet:0, tab:'history' });
    }
  });
}

export function reset(ctl: Ctl) {
  clearInterval(ctl.run); clearInterval(ctl.trk);
  ctl.set({ tab:'deposit', depStep:'form', depDigits:'500', depProg:0,
    sendStep:1, sndDigits:'1000', pick:'PH', addr:'',
    elapsed:0, trackProg:0, txHash:'', ledger:0, pos:{}, vaultDigits:'',
    vaultPick:'blend', sign:null, signState:'ask', wallet:270.70, history:[] });
}
