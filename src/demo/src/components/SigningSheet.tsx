import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';

export default function SigningSheet({ v }: { v: Vals }) {
  return (
      <div style={css("position:fixed; inset:0; z-index:60; background:rgba(18,23,23,.45); display:flex; align-items:center; justify-content:center; padding:var(--sp-5)")}>
            <div style={css("width:100%; max-width:380px; background:var(--surface); border-radius:var(--r-lg); box-shadow:var(--e-3); overflow:hidden; animation:dRise .28s cubic-bezier(.16,1,.3,1) both")}>

              <div style={css("padding:var(--sp-4) var(--sp-5); border-bottom:1px solid var(--line); display:flex; align-items:center; gap:var(--sp-3)")}>
                <span style={css("display:grid; place-items:center; width:26px; height:26px; border-radius:var(--r-xs); background:var(--n-900); color:var(--n-0); font-family:var(--mono); font-size:11px; font-weight:500")}>W</span>
                <span style={css("font-size:14.5px; font-weight:600")}>Wallet</span>
                <span style={css("margin-left:auto; font-family:var(--mono); font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--subtle)")}>Mock &middot; testnet</span>
              </div>

              {v.signAsk ? (<>
                <div style={css("padding:var(--sp-5)")}>
                  <div style={css("font-size:17px; font-weight:600")}>{v.signTitle}</div>
                  <p style={css("margin:var(--sp-2) 0 0; font-size:13.5px; color:var(--muted)")}>
                    Corra cannot move your balance. This transaction only leaves your device
                    once you sign it.</p>

                  <div style={css("margin-top:var(--sp-5); padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); display:flex; flex-direction:column; gap:var(--sp-2)")}>
                    <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Operation</span>
                      <span style={css("font-family:var(--mono); font-size:13px")}>{v.signOp}</span></div>
                    <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Amount</span>
                      <span style={css("font-family:var(--mono); font-weight:500")}>{v.signAmt}</span></div>
                    <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Destination</span>
                      <span style={css("font-family:var(--mono); font-size:13px")}>{v.signDest}</span></div>
                    <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Network fee</span>
                      <span style={css("font-family:var(--mono); font-size:13px")}>0.0000100 XLM</span></div>
                  </div>

                  <div style={css("margin-top:var(--sp-5); display:grid; grid-template-columns:1fr 1fr; gap:var(--sp-2)")}>
                    <button onClick={v.signReject} style={css(v.ghostFlat)}>Reject</button>
                    <button onClick={v.signGo} style={css(v.ctaFlat)}>Sign</button>
                  </div>
                </div>
              </>) : null}

              {v.signBusy ? (<>
                <div style={css("padding:var(--sp-8) var(--sp-5); text-align:center")}>
                  <div style={css("display:inline-block; width:40px; height:40px; border-radius:50%; border:3px solid var(--weak-line); border-top-color:var(--brand); animation:dSpin .9s linear infinite")}></div>
                  <div style={css("margin-top:var(--sp-4); font-size:15.5px; font-weight:600")}>Signing</div>
                  <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:12px; color:var(--muted)")}>{v.signAmt}</div>
                </div>
              </>) : null}
            </div>
          </div>
  );
}
