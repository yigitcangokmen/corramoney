import { CYCLE, T, TAPS } from './timing';

export type Vals = Record<string, any>;

export function deriveVals(e: number): Vals {
  const t = e % CYCLE;
  const btw = (a: number, b: number) => t >= a && t < b;

  const listOpen = btw(T.open, T.close);
  const picked = t >= T.tick && t < T.reset;
  const showTick = t >= T.tick;
  const amountOpen = t >= T.amount && t < T.reset;
  const sending = btw(T.send, T.done);
  const done = t >= T.done && t < T.reset;
  const prog = sending
    ? Math.min(100, ((t - T.send) / (T.settle - T.send)) * 100)
    : (done ? 100 : 0);

  const tap = (k: keyof typeof TAPS) => btw(TAPS[k], TAPS[k] + 0.7);
  const dip = (k: keyof typeof TAPS) => btw(TAPS[k], TAPS[k] + 0.2) ? 'scale(.985)' : 'scale(1)';

  const row = (i: number, from: number, to: number, selected: boolean) => {
    const hot = btw(from, to);
    const bg = selected && showTick ? 'var(--weak)' : hot ? 'var(--sunken)' : 'var(--surface)';
    return 'position:relative; overflow:hidden; display:flex; align-items:center;' +
      'gap:var(--sp-3); padding:var(--sp-3); background:' + bg + ';' +
      (selected ? 'transform:' + dip('row') + ';' : '') +
      'transition:background .42s linear, transform .18s cubic-bezier(.16,1,.3,1);' +
      (i < 3 ? 'border-bottom:1px solid var(--line);' : '') +
      'animation:pvRow .5s cubic-bezier(.16,1,.3,1) ' + ((i - 1) * 0.12) + 's both;';
  };

  const status = done
    ? { t:'₱11,210.00 delivered', c:'var(--ink-brand)' }
    : t < T.send + 1.5 ? { t:'Contacting Coins.ph', c:'var(--muted)' }
    : t < T.settle - 0.9 ? { t:'Converting to pesos', c:'var(--muted)' }
    : { t:'Crediting the account', c:'var(--muted)' };

  // routing rail
  // wrapped off the UNWRAPPED elapsed time so nothing can jump backwards.
  // MXNe arrives -> MXNe -> USDC -> USDC -> PHP payout -> the anchor pays out
  const RIDE = 7;
  const r = e % RIDE;
  const R = {
    go1:0.25, land1:1.1,
    swap1:1.3, swap1Off:3.05,
    swap2:3.2, swap2Off:4.95,
    go2:5.15, land2:6.0
  };
  const rBtw = (a: number, b: number) => r >= a && r < b;

  const cardOn = rBtw(R.swap1, R.swap1Off) || rBtw(R.swap2, R.swap2Off);
  const leg2 = r >= R.swap2;

  const MX_RING = 'conic-gradient(from 200deg,var(--flag-mx-green) 0 50%,var(--flag-mx-red) 50% 100%)';
  const PHP_RING = 'conic-gradient(from 214deg,var(--flag-ph-blue) 0 40%,var(--flag-ph-red) 40% 80%,#fff 80% 100%)';

  const ride2 = r >= R.go2 - 0.12;
  const carry = ride2 ? 'php' : 'mx';
  const STOP = { try: 62, hub: 190, php: 318 };
  const x = ride2
    ? (r < R.go2 ? STOP.hub : STOP.php)
    : (r < R.go1 ? STOP.try : STOP.hub);
  const seen = rBtw(R.go1 + 0.12, R.land1 - 0.14) || rBtw(R.go2 + 0.12, R.land2 - 0.14);
  const gone = !seen;
  const shrink = rBtw(R.land1 - 0.14, R.land1 + 0.15) || rBtw(R.land2 - 0.14, R.land2 + 0.15);
  const noTween = r < 0.18 || rBtw(R.go2 - 0.12, R.go2);
  const delivered = r >= R.land2;

  // cash-in
  const CI = 8.4;
  const ci = e % CI;
  const ciBtw = (a: number, b: number) => ci >= a && ci < b;
  const CLABE = '002 180 07012345678 9';
  const AMT = 'MX$3,500.00';
  const ciType = (text: string, from: number, dur: number) => {
    if (ci < from) return { s:' ', live:false, filled:false };
    const p = Math.min(1, (ci - from) / dur);
    return { s: text.slice(0, Math.round(p * text.length)) || ' ',
             live: p < 1, filled: p >= 1 };
  };
  const ciIban = ciType(CLABE, 0.7, 1.5);
  const ciAmt = ciType(AMT, 2.6, 0.6);
  const ciTap = ciBtw(3.6, 4.3);
  const ciSending = ciBtw(3.9, 5.5);
  const ciDone = ci >= 5.5;
  const ciField = (live: boolean, amber: boolean) =>
    'margin-top:var(--sp-2); padding:var(--sp-3) var(--sp-4); border-radius:var(--r-sm);' +
    'transition:border-color .25s linear, box-shadow .25s linear;' +
    'background:' + (amber ? 'transparent' : 'var(--sunken)') + ';' +
    'border:1px solid ' + (live ? 'var(--brand)' : amber ? 'var(--weak-line)' : 'var(--line)') + ';' +
    'box-shadow:' + (live ? 'var(--e-focus)' : 'none') + ';';
  const ciCaret = (live: boolean) =>
    'display:inline-block; width:1.5px; height:1em; vertical-align:-.12em;' +
    'margin-left:2px; background:currentColor;' +
    (live ? 'animation:ciCaret .9s steps(1) infinite;' : 'opacity:0;');

  // idle balance
  const yb = 1.84 + (e % 300) * 0.0027;

  // proof
  const prGap = e % 7.5 < 0.4;

  return {
    pkt: 'position:absolute; left:0; top:0; display:block; white-space:nowrap;' +
      'font-family:var(--mono); font-size:11.5px; font-weight:500;' +
      'padding:6px 12px; border-radius:var(--r-sm); background:var(--surface);' +
      'border:1px solid var(--weak-line); box-shadow:var(--e-2); color:var(--ink-brand);',

    prIn: !prGap,
    prCoinMx: 'flex:none; width:32px; height:32px; border-radius:50%; display:grid;' +
      'place-items:center;' +
      'background:conic-gradient(from 200deg,var(--flag-mx-green) 0 50%,var(--flag-mx-red) 50% 100%);',
    prCoinPhp: 'flex:none; width:32px; height:32px; border-radius:50%; display:grid;' +
      'place-items:center;' +
      'background:conic-gradient(from 214deg,var(--flag-ph-blue) 0 40%,var(--flag-ph-red) 40% 80%,#fff 80% 100%);',
    prCoinIn: 'width:24px; height:24px; border-radius:50%; background:var(--n-0);' +
      'display:grid; place-items:center; font-family:var(--mono); font-size:12px;' +
      'font-weight:500; color:var(--n-900);',
    prCoinInMx: 'width:24px; height:24px; border-radius:50%; background:var(--n-0);' +
      'display:grid; place-items:center; font-family:var(--mono); font-size:8px;' +
      'font-weight:500; color:var(--n-900);',

    ciForm: !ciDone, ciDone: ciDone, ciSending: ciSending,
    ciIdle: !ciSending, ciTap: ciTap,
    ciIban: ciIban.s, ciAmt: ciAmt.s,
    ciIbanCaret: ciCaret(ciIban.live), ciAmtCaret: ciCaret(ciAmt.live),
    ciF1: ciField(ciIban.live, false),
    ciF2: ciField(false, false),
    ciF3: ciField(ciAmt.live, true),
    ciBtn: 'position:relative; overflow:hidden; margin-top:var(--sp-4); height:48px;' +
      'border-radius:var(--r-sm); display:flex; align-items:center; justify-content:center;' +
      'font-size:15px; font-weight:600; line-height:1;' +
      'transition:background .3s linear, color .3s linear,' +
      'transform .18s cubic-bezier(.16,1,.3,1);' +
      'transform:scale(' + (ciBtw(3.6, 3.8) ? '.975' : '1') + ');' +
      (ciAmt.filled
        ? 'background:var(--brand); color:var(--on); box-shadow:var(--e-2);'
        : 'background:var(--n-100); color:var(--n-600);'),
    ciWash: 'position:absolute; inset:0; z-index:1; pointer-events:none;' +
      'transition:opacity .7s linear; opacity:' + (ciDone ? '1' : '0') + ';' +
      'background:radial-gradient(120% 90% at 50% 118%, rgba(47,203,114,.18) 0%,' +
      'rgba(47,203,114,.05) 42%, rgba(47,203,114,0) 74%);',

    ybEarned: yb.toFixed(4),
    ybDigits: yb.toFixed(2).slice(2).split('').map((d, i) => ({
      v: d,
      style: 'display:inline-block; color:var(--text);' +
        (i === 1 ? 'animation:wbTick .22s linear infinite alternate;' : '')
    })),
    ybDotStyle: 'display:block; width:6px; height:6px; border-radius:50%;' +
      'background:var(--brand);' +
      'animation:pvPulse 1.6s ease-in-out infinite;',
    ybBarStyle: 'height:100%; background:var(--brand); border-radius:var(--r-xs);' +
      'width:' + (18 + (e % 300) / 300 * 64).toFixed(1) + '%;' +
      'transition:width .4s linear;',

    rtLeg1: !leg2, rtLeg2: leg2,
    rtCardOn: cardOn,

    rtCardStyle: 'position:absolute; z-index:9; white-space:nowrap;' +
      'background:rgba(255,255,255,.95); border:1px solid var(--weak-line);' +
      'border-radius:var(--r-md); padding:var(--sp-3) var(--sp-5) var(--sp-4); box-shadow:var(--e-2);' +
      'text-align:center; transform:translateX(-50%);' +
      'left:50%; bottom:144px;' +
      'animation:rtCard .34s var(--ease-out) both;',
    rtHitHub: cardOn, rtHitEnd: cardOn,
    rtArrow1: 'animation:rtPulse .8s ease-in-out both;',
    rtArrow2: 'animation:rtPulse .8s ease-in-out both;',
    rtFlash1: rBtw(R.swap1, R.swap1 + 1.2) || rBtw(R.swap2, R.swap2 + 1.2),
    rtFlash2: rBtw(R.land2, R.land2 + 1.2),

    rtPhpNode: 'position:absolute; left:' + 318 / 380 * 100 + '%; top:144px;' +
      'width:40px; height:40px; border-radius:50%; display:grid; place-items:center;' +
      'background:' + PHP_RING + ';' +
      'box-shadow:' + (delivered ? 'var(--e-3)' : 'var(--e-2)') + ';' +
      'transform:translate(-50%,-50%) scale(' + (delivered ? '1.08' : '1') + ');' +
      'transition:transform .5s var(--ease-out), box-shadow .5s linear;',

    rtPacketGlyph: carry === 'php' ? '₱' : 'MX$',
    rtPacketInner: 'width:31px; height:31px; border-radius:50%; display:grid;' +
      'place-items:center; font-family:var(--mono); font-weight:500;' +
      'font-size:' + (carry === 'php' ? '15px' : '10.5px') + ';' +
      'background:var(--n-0); color:var(--n-900);',
    rtPacketStyle: 'position:absolute; top:144px; width:40px; height:40px;' +
      'margin:-20px 0 0 -20px; border-radius:50%; display:grid; place-items:center;' +
      'box-shadow:var(--e-2); z-index:4;' +
      'left:' + x / 380 * 100 + '%;' +
      'background:' + (carry === 'php' ? PHP_RING : MX_RING) + ';' +
      'opacity:' + (gone ? '0' : '1') + ';' +
      'transform:scale(' + (shrink ? '.55' : '1') + ');' +
      (noTween
        ? 'transition:none;'
        : 'transition:left .8s cubic-bezier(.3,.1,.32,1), opacity .22s linear,' +
          'transform .26s cubic-bezier(.16,1,.3,1), background .3s linear;'),

    pvListOpen: listOpen, pvShowTick: showTick,
    pvPicked: picked, pvNoPick: !picked,
    pvTapSel: tap('sel'), pvTapRow: tap('row'), pvTapBtn: tap('btn'),

    pvSel: 'position:relative; overflow:hidden; display:flex; align-items:center;' +
      'gap:var(--sp-3); padding:var(--sp-3) var(--sp-4); background:var(--surface);' +
      'border-radius:var(--r-sm); transform:' + dip('sel') + ';' +
      'transition:border-color .2s linear, box-shadow .2s linear,' +
      'transform .18s cubic-bezier(.16,1,.3,1);' +
      'border:1px solid ' + (listOpen ? 'var(--brand)' : picked ? 'var(--weak-line)' : 'var(--line)') + ';' +
      'box-shadow:' + (listOpen ? 'var(--e-focus)' : 'var(--e-1)') + ';',
    pvChev: 'flex:none; color:var(--muted); display:block;' +
      'transition:transform .28s cubic-bezier(.16,1,.3,1);' +
      'transform:rotate(' + (listOpen ? '180deg' : '0deg') + ');',

    pvRow1: row(1, T.hi1, T.hi2, false),
    pvRow2: row(2, T.hi2, T.hi3, false),
    pvRow3: row(3, T.hi3, T.tick, true),
    pvDot3: 'flex:none; width:24px; height:24px; border-radius:50%; display:grid;' +
      'place-items:center; transition:filter .3s linear;' +
      'background:conic-gradient(from 214deg,var(--flag-ph-blue) 0 40%,var(--flag-ph-red) 40% 80%,#fff 80% 100%);' +
      'filter:' + (showTick ? 'none' : 'saturate(.35)') + ';',

    pvAmt: 'overflow:hidden; transition:max-height .36s cubic-bezier(.16,1,.3,1),' +
      'opacity .28s linear, margin-top .36s cubic-bezier(.16,1,.3,1);' +
      'max-height:' + (amountOpen ? '100px' : '0px') + ';' +
      'opacity:' + (amountOpen ? '1' : '0') + ';' +
      'margin-top:' + (amountOpen ? '14px' : '0') + ';',

    pvIdle: !sending && !done, pvSending: sending, pvDone: done,
    pvPress: 'position:relative; margin-top:var(--sp-4);' +
      'transition:transform .16s cubic-bezier(.16,1,.3,1);' +
      'transform:' + (btw(TAPS.btn, TAPS.btn + 0.26) ? 'scale(.975)' : 'scale(1)') + ';',
    pvBtn: 'position:relative; overflow:hidden; height:48px; border-radius:var(--r-sm);' +
      'display:flex; align-items:center; justify-content:center; color:var(--on);' +
      'font-size:15px; font-weight:600; line-height:1;' +
      'transition:background .3s linear, box-shadow .35s linear;' +
      'background:' + (done ? 'var(--green-800)' : 'var(--brand)') + ';' +
      'box-shadow:' + (done ? 'var(--e-3)' : 'var(--e-2)') + ';',
    pvBar: 'position:absolute; left:0; bottom:0; height:3px; background:#fff;' +
      'transition:width .12s linear, opacity .3s linear;' +
      'width:' + prog + '%; opacity:' + (sending ? '.55' : '0') + ';',

    pvHasStatus: sending || done,
    pvStatusText: status.t, pvStatusColor: status.c,
    pvStatusDot: 'display:block; width:6px; height:6px; border-radius:50%;' +
      'background:' + (done ? 'var(--brand)' : 'var(--n-400)') + ';' +
      (done ? '' : 'animation:pvPulse 1s ease-in-out infinite;'),

    corTrack: 'margin-top:var(--sp-5); height:4px; border-radius:var(--r-xs);' +
      'background:var(--n-100); overflow:hidden;',
    corTrackDark: 'margin-top:var(--sp-5); height:4px; border-radius:var(--r-xs);' +
      'background:rgba(255,255,255,.14); overflow:hidden;',
    corFill35: 'height:100%; width:35%; border-radius:var(--r-xs); background:var(--brand);',
    corFill25: 'height:100%; width:25%; border-radius:var(--r-xs); background:var(--brand);',
    corFill15: 'height:100%; width:15%; border-radius:var(--r-xs);' +
      'background:var(--green-400);',
    corNote: 'margin-top:var(--sp-3); font-family:var(--mono); font-size:11px;' +
      'letter-spacing:.12em; text-transform:uppercase; color:var(--n-600);',
    corNoteDark: 'margin-top:var(--sp-3); font-family:var(--mono); font-size:11px;' +
      'letter-spacing:.12em; text-transform:uppercase; color:var(--green-300);',

    pvWash: 'position:absolute; inset:0; z-index:1; pointer-events:none;' +
      'transition:opacity .7s linear; opacity:' + (done ? '1' : '0') + ';' +
      'background:radial-gradient(120% 90% at 50% 118%, rgba(47,203,114,.20) 0%,' +
      'rgba(47,203,114,.06) 40%, rgba(47,203,114,0) 72%);'
  };
}
