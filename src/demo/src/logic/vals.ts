import { VAULTS, CORR, TABS, TRACK } from './data';
import { chip, cta, flat, hint as hintFor } from './styles';
import { earnedOf } from './helpers';
import type { Ctl } from './types';

export type Vals = Record<string, any>;

export function buildVals(ctl: Ctl): Vals {
  const s = ctl.state;
  const dep = ctl.amt('depDigits'), snd = ctl.amt('sndDigits');
  const c = ctl.corr();
  const depOk = dep >= ctl.minAmt && dep <= ctl.maxAmt;
  const sndOk = snd >= ctl.minAmt && snd <= ctl.maxAmt && s.addr.length > 20;

  const hint = (a: number, ok: boolean) => hintFor(a, ok, ctl.minAmt);

  const sndOut = ctl.usdc(snd) * (1 - ctl.spread) * c.rate;

  return {
    rateTop: '1 USDC = ' + ctl.n(ctl.rate, 2) + ' TRY',
    rowStyle: 'display:flex; justify-content:space-between; gap:var(--sp-3); font-size:14px;',
    kStyle: 'font-family:var(--mono); font-size:10px; letter-spacing:.14em;' +
      'text-transform:uppercase; color:var(--subtle);',
    chipStyle: chip,
    ctaStyle: cta(true),
    ghostStyle: 'width:100%; margin-top:var(--sp-5); font-size:15px; font-weight:600;' +
      'padding:var(--sp-4); border-radius:var(--r-sm); cursor:pointer; line-height:1.2;' +
      'background:var(--surface); color:var(--text); border:1px solid var(--line-strong);',
    ctaFlat: flat(true), ghostFlat: flat(false),

    tabs: TABS.map(([id, label]) => ({
      label: label,
      go: () => ctl.set({ tab:id }),
      style: 'font-size:14px; font-weight:600; padding:var(--sp-2) var(--sp-4);' +
        'border-radius:var(--r-sm); cursor:pointer; line-height:1.4;' +
        (s.tab === id
          ? 'background:var(--brand); color:var(--on); border:1px solid var(--brand);'
          : 'background:transparent; color:var(--muted); border:1px solid transparent;')
    })),

    isDeposit: s.tab === 'deposit', isSend: s.tab === 'send',
    isYield: s.tab === 'yield', isHistory: s.tab === 'history',
    goDeposit: () => ctl.set({ tab:'deposit' }),
    goSend: () => ctl.set({ tab:'send', sendStep:1 }),
    goYield: () => ctl.set({ tab:'yield' }),
    goHistory: () => ctl.set({ tab:'history' }),
    reset: () => ctl.reset(),

    depForm: s.depStep === 'form', depWaiting: s.depStep === 'waiting',
    depClearing: s.depStep === 'clearing', depDone: s.depStep === 'done',
    depText: dep === 0 ? '' : ctl.n(dep, 0),
    onDep: e => ctl.set({
      depDigits: String(e.target.value).replace(/[^0-9]/g, '').slice(0, 6) || '0' }),
    depA: () => ctl.set({ depDigits:'500' }),
    depB: () => ctl.set({ depDigits:'1000' }),
    depC: () => ctl.set({ depDigits:'3000' }),
    depLine: depOk || dep === 0 ? 'var(--line)' : 'var(--amber-line)',
    depHint: hint(dep, depOk),
    depHintColor: depOk || dep === 0 ? 'var(--subtle)' : 'var(--amber)',
    depNotReady: !depOk,
    depBtnStyle: cta(depOk),
    depTry: '\u20BA' + ctl.n(dep, 2),
    depUsdc: ctl.n(ctl.usdc(dep), 2) + ' USDC',
    depRef: 'CORRA-' + s.depRef,
    depRefCode: 'CORRA-' + s.depRef + '-TRY',
    depProg: s.depProg + '%',
    depGo: () => ctl.depGo(), depSim: () => ctl.depSim(),
    depBack: () => ctl.set({ depStep:'form' }),
    depAgain: () => ctl.set({ depStep:'form' }),

    sf1: s.sendStep === 1, sf2: s.sendStep === 2, sf3: s.sendStep === 3,
    sf4: s.sendStep === 4, sf5: s.sendStep === 5,
    stepRail: [1,2,3,4,5].map((i, idx, arr) => {
      const done = s.sendStep > i, now = s.sendStep === i;
      return {
        mark: done ? '\u2713' : String(i),
        wrap: 'display:flex; align-items:center; gap:var(--sp-2);' +
          (idx < arr.length - 1 ? 'flex:1;' : 'flex:none;'),
        dot: 'flex:none; width:26px; height:26px; border-radius:50%; display:grid;' +
          'place-items:center; font-family:var(--mono); font-size:11px; font-weight:500;' +
          'transition:all .25s linear;' +
          (done ? 'background:var(--brand); color:var(--on);'
            : now ? 'background:var(--weak); color:var(--ink-brand);' +
                    'box-shadow:0 0 0 3px rgba(14,133,70,.14), inset 0 0 0 1px var(--weak-line);'
                  : 'background:var(--n-100); color:var(--n-500);'),
        bar: (idx < arr.length - 1
          ? 'flex:1; height:2px; border-radius:1px; transition:background .25s linear;' +
            'background:' + (done ? 'var(--brand)' : 'var(--n-100)') + ';'
          : 'display:none;')
      };
    }),
    sndText: snd === 0 ? '' : ctl.n(snd, 0),
    onSnd: e => ctl.set({
      sndDigits: String(e.target.value).replace(/[^0-9]/g, '').slice(0, 6) || '0' }),
    sndLine: sndOk || snd === 0 ? 'var(--line)' : 'var(--amber-line)',
    sndHint: hint(snd, snd >= ctl.minAmt && snd <= ctl.maxAmt),
    sndHintColor: snd >= ctl.minAmt && snd <= ctl.maxAmt ? 'var(--subtle)' : 'var(--amber)',
    sndNotReady: !sndOk, sndBtnStyle: cta(sndOk),
    sndNext: () => { if (sndOk) ctl.set({ sendStep:2 }); },
    sndBack: () => ctl.set({ sendStep:1 }),
    sndSign: () => ctl.sndSign(),
    sndSim: () => ctl.sndSim(),
    sndAgain: () => ctl.set({ sendStep:1, addr:'' }),
    sndTry: '\u20BA' + ctl.n(snd, 2),
    sndUsdc: ctl.n(ctl.usdc(snd), 2) + ' USDC',
    sndOut: c.sym + ctl.n(sndOut, 2),
    sagaId: s.saga + '-5181-4f75-880c',
    corridors: CORR.map(o => ({
      iso:o.iso, name:o.name, cur:o.cur,
      pick: () => ctl.set({ pick:o.iso }),
      style: 'padding:var(--sp-4); border-radius:var(--r-sm); cursor:pointer;' +
        'text-align:center; transition:all .18s linear;' +
        (s.pick === o.iso
          ? 'background:var(--weak); border:1px solid var(--brand);' +
            'box-shadow:0 0 0 3px rgba(14,133,70,.12);'
          : 'background:var(--surface); border:1px solid var(--line);'),
      code: 'display:inline-block; font-family:var(--mono); font-size:12px;' +
        'font-weight:500; letter-spacing:.1em; padding:3px var(--sp-2);' +
        'border-radius:var(--r-xs);' +
        (s.pick === o.iso
          ? 'background:var(--brand); color:var(--on);'
          : 'background:var(--sunken); color:var(--n-700);')
    })),
    pickName: c.name, pickCur: c.cur, pickIso: c.iso,
    recvLabel: 'They receive (' + c.cur + ')',
    addrText: s.addr,
    onAddr: e => ctl.set({ addr:String(e.target.value).trim() }),
    useDemo: () => ctl.set({
      addr:'GACLSIXJM43JYSE4NYNUKQT377YIIQNAO3QB3KRQHZE2RVS5XAHJ5SBV' }),
    addrShort: s.addr ? s.addr.slice(0, 6) + '\u2026' + s.addr.slice(-6) : '\u2014',
    trackPct: s.trackProg + '%',
    elapsedLabel: ctl.n(s.elapsed, 1) + ' s',
    senderBal: ctl.n(Math.max(0, s.wallet - ctl.usdc(snd) * (s.trackProg / 100)), 2) + ' USDC',
    recvBal: c.sym + ctl.n(sndOut * (s.trackProg / 100), 2),
    trackSteps: TRACK.map((label, i) => {
      const at = [0, 34, 68, 100][i];
      const done = s.trackProg >= at && (i < 3 || s.trackProg >= 100);
      const now = !done && s.trackProg >= at - 34;
      return {
        label: label,
        mark: done ? '\u2713' : '',
        at: done ? ctl.n(at * 0.052, 1) + ' s' : '',
        weight: now || done ? '600' : '400',
        style: 'display:flex; align-items:center; gap:var(--sp-3);' +
          'padding:var(--sp-3) var(--sp-4); border-radius:var(--r-sm);' +
          'transition:background .25s linear;' +
          'background:' + (done ? 'var(--weak)' : now ? 'var(--sunken)' : 'transparent') + ';' +
          'opacity:' + (done || now ? '1' : '.5') + ';',
        dot: 'flex:none; width:20px; height:20px; border-radius:50%; display:grid;' +
          'place-items:center; font-size:11px; font-weight:700; color:var(--on);' +
          'background:' + (done ? 'var(--brand)' : 'var(--n-200)') + ';' +
          (now ? 'animation:dPulse 1.4s ease-in-out infinite;' : '')
      };
    }),
    timings: [
      ['Quote and signature', 1.6, 1.6], ['Routing', 1.1, 1.1],
      ['Confirm and submit', 2.5, 2.5], ['A bank wire, for comparison', 72, 0]
    ].map(([label, v, own]) => ({
      label: label,
      val: own ? ctl.n(v, 1) + ' s' : '1\u20133 days',
      labelColor: own ? 'var(--text)' : 'var(--muted)',
      fill: 'height:100%; border-radius:var(--r-xs); width:' +
        Math.round((v / 72) * 100) + '%; background:' +
        (own ? 'var(--brand)' : 'var(--n-300)') + ';'
    })),
    txHash: s.txHash ? s.txHash + '\u2026' : '\u2014',
    ledger: s.ledger ? '#' + s.ledger : '\u2014',

    vaults: VAULTS.map(v => ({
      name:v.name, note:v.note, addr:v.addr, apy: ctl.n(v.apy, 1) + '%',
      pick: () => ctl.set({ vaultPick:v.id }),
      style: 'padding:var(--sp-4); border-radius:var(--r-sm); cursor:pointer;' +
        'text-align:left; transition:all .18s linear;' +
        (s.vaultPick === v.id
          ? 'background:var(--weak); border:1px solid var(--brand);' +
            'box-shadow:0 0 0 3px rgba(14,133,70,.12);'
          : 'background:var(--surface); border:1px solid var(--line);')
    })),
    posCount: Object.keys(s.pos).length +
      (Object.keys(s.pos).length === 1 ? ' vault' : ' vaults'),
    positions: Object.keys(s.pos).map(id => {
      const p = s.pos[id], v = VAULTS.find(x => x.id === id)!;
      const gained = earnedOf(p, v.apy);
      return {
        name: v.name,
        amt: ctl.n(p.amt, 2) + ' USDC',
        apy: ctl.n(v.apy, 1) + '% annual',
        age: ctl.n((Date.now() - p.at) / 1000, 0) + ' s ago',
        earnBig: '+' + ctl.n(gained, 4),
        earnTail: gained.toFixed(7).slice(-3),
        out: () => ctl.vaultOut(id)
      };
    }),

    signOpen: !!s.sign,
    signAsk: !!s.sign && s.signState === 'ask',
    signBusy: !!s.sign && s.signState === 'busy',
    signTitle: s.sign ? s.sign.title : '',
    signOp: s.sign ? s.sign.op : '',
    signAmt: s.sign ? s.sign.amt : '',
    signDest: s.sign ? s.sign.dest : '',
    signGo: () => ctl.signGo(),
    signReject: () => ctl.signReject(),

    vaultLabel: ctl.n(ctl.totalVault(), 2) + ' USDC',
    walletLabel: ctl.n(s.wallet, 2) + ' USDC',
    earnedBig: '+' + ctl.n(ctl.totalEarned(), 4),
    earnedTail: ctl.totalEarned().toFixed(7).slice(-3),
    tickerBig: ctl.n(ctl.totalEarned(), 4),
    tickerTail: String(ctl.totalEarned().toFixed(9)).slice(-5),
    vaultText: s.vaultDigits,
    onVault: e => ctl.set({
      vaultDigits: String(e.target.value).replace(/[^0-9.,]/g, '').replace(',', '.') }),
    vaultGo: () => ctl.vaultGo(),
    cashOut: () => ctl.cashOut(),
    vaultNotReady: !(parseFloat(s.vaultDigits) > 0 &&
      parseFloat(s.vaultDigits) <= s.wallet),
    vaultBtnStyle: flat(parseFloat(s.vaultDigits) > 0 &&
      parseFloat(s.vaultDigits) <= s.wallet).replace('padding:var(--sp-3) var(--sp-4)',
      'padding:var(--sp-4) var(--sp-6)'),
    hasPosition: Object.keys(s.pos).length > 0,

    history: s.history.map(e => ({
      kind:e.kind, state:e.state, when:e.when,
      inAmt:e.inAmt, outAmt:e.outAmt, tx:e.tx ? e.tx + '\u2026' : '',
      hasTx: !!e.tx, earned:e.earned || '', hasEarned: !!e.earned,
      stateColor: e.tone ? 'var(--ink-brand)' : 'var(--amber)',
      dot: 'flex:none; width:8px; height:8px; border-radius:50%; background:' +
        (e.tone ? 'var(--brand)' : 'var(--amber)') + ';',
      style: 'background:var(--surface); border-radius:var(--r-md);' +
        'padding:var(--sp-5); box-shadow:var(--e-1); border:1px solid ' +
        (e.tone ? 'var(--weak-line)' : 'var(--amber-line)') + ';'
    })),
    hasHistory: s.history.length > 0,
    historyEmpty: s.history.length === 0,
    historyCount: s.history.length + (s.history.length === 1 ? ' record' : ' records')
  };
}
