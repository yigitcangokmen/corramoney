import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';

export default function TopBar({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Top bar" style={css("position:sticky; top:0; z-index:40; background:rgba(255,255,255,.92); backdrop-filter:blur(12px); border-bottom:1px solid var(--line)")}>
          <div style={css("max-width:1080px; margin:0 auto; padding:0 var(--sp-5); height:64px; display:flex; align-items:center; gap:var(--sp-4); box-sizing:border-box")}>
            <div style={css("display:inline-flex; align-items:center; gap:0.34em; font-size:18px")}>
              <svg viewBox="0 0 100 100" fill="none" style={css("height:1.15em; width:auto; display:block")}>
                <path d="M82 24a36 36 0 100 52L62 60a14 14 0 110-20z" fill="var(--brand)"></path></svg>
              <span style={css("font-weight:600; letter-spacing:-.02em; line-height:1")}>Corra</span>
            </div>
            <span style={css("display:inline-flex; align-items:center; gap:var(--sp-2); font-family:var(--mono); font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-brand); background:var(--weak); border:1px solid var(--weak-line); border-radius:var(--r-xs); padding:3px var(--sp-2)")}>
              <span style={css("width:6px; height:6px; border-radius:50%; background:var(--brand); animation:dPulse 2.4s ease-in-out infinite")}></span>Testnet</span>
            <span style={css("font-family:var(--mono); font-size:12.5px; color:var(--muted)")}>{v.rateTop}</span>

            <div style={css("margin-left:auto; display:flex; align-items:center; gap:var(--sp-4)")}>
              <div style={css("text-align:right")}>
                <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Wallet</div>
                <div style={css("font-family:var(--mono); font-size:14px; font-weight:500; font-variant-numeric:tabular-nums")}>{v.walletLabel}</div>
              </div>
              <span style={css("font-family:var(--mono); font-size:12px; color:var(--muted); padding:var(--sp-2) var(--sp-3); border:1px solid var(--line); border-radius:var(--r-sm)")}>GAJL…2677</span>
              <button onClick={v.reset} style={css("font-size:13px; font-weight:600; padding:var(--sp-2) var(--sp-4); background:var(--surface); color:var(--text); border:1px solid var(--line-strong); border-radius:var(--r-sm); cursor:pointer")}>Reset</button>
            </div>
          </div>

          
      </div>
  );
}
