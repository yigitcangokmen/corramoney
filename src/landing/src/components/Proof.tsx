import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function Proof({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Confirmation" style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); box-shadow:var(--e-1); overflow:hidden; display:grid; grid-template-columns:repeat(auto-fit, minmax(300px,1fr))")}>

              <div style={css("background:var(--sunken); border-right:1px solid var(--line); min-height:352px; display:flex; align-items:center; justify-content:center; padding:var(--sp-6)")}>
                {v.prIn ? (<>
                <div style={css("position:relative; overflow:hidden; width:100%; max-width:296px; background:var(--surface); border:1px solid var(--line); border-radius:var(--r-md); box-shadow:var(--e-2); animation:prCard .6s cubic-bezier(.16,1,.3,1) both")}>

                  <span style={css("position:absolute; top:0; bottom:0; left:0; width:42%; z-index:4; pointer-events:none; background:linear-gradient(104deg, transparent, rgba(47,203,114,.20), transparent); animation:prSheen 1.1s linear 1.7s both")}></span>

                  <div style={css("padding:var(--sp-4); border-bottom:1px solid var(--line); text-align:center")}>
                    <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); animation:prRow .5s cubic-bezier(.16,1,.3,1) .35s both")}>Your transfer</div>
                    <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:22px; font-weight:500; letter-spacing:.04em; animation:prStamp .55s var(--ease-out) .5s both")}>CORRA&#8209;8412&#8209;TRY</div>
                  </div>

                  <div style={css("padding:var(--sp-4); display:flex; flex-direction:column; gap:var(--sp-3)")}>
                    <div style={css("display:flex; align-items:center; gap:var(--sp-3); animation:prRow .5s cubic-bezier(.16,1,.3,1) .85s both")}>
                      <span style={css(v.prCoinTry)}><span style={css(v.prCoinIn)}>&#8378;</span></span>
                      <span style={css("min-width:0; flex:1")}>
                        <span style={css("display:block; font-size:13.5px; font-weight:500")}>Emre sent</span>
                        <span style={css("display:block; font-family:var(--mono); font-size:13px; color:var(--muted)")}>&#8378;3,500.00</span></span>
                    </div>
                    <div style={css("display:flex; align-items:center; gap:var(--sp-3); animation:prRow .5s cubic-bezier(.16,1,.3,1) 1.25s both")}>
                      <span style={css("position:relative; flex:none; display:block")}>
                        <span style={css("position:absolute; inset:0; border-radius:50%; border:2px solid var(--green-400); pointer-events:none; animation:prRing .9s cubic-bezier(.16,1,.3,1) 1.5s both")}></span>
                        <span style={css(v.prCoinPhp)}><span style={css(v.prCoinIn)}>&#8369;</span></span>
                      </span>
                      <span style={css("min-width:0; flex:1")}>
                        <span style={css("display:block; font-size:13.5px; font-weight:500")}>Maria received</span>
                        <span style={css("display:block; font-family:var(--mono); font-size:13px; color:var(--ink-brand); animation:prLand .6s var(--ease-out) 1.5s both")}>&#8369;4,050.02</span></span>
                    </div>
                  </div>

                  <a href="https://stellar.expert" target="_blank" rel="noopener" style={css("display:flex; align-items:center; justify-content:space-between; gap:var(--sp-3); padding:var(--sp-3) var(--sp-4); background:var(--weak); border-top:1px solid var(--weak-line); font-family:var(--mono); font-size:10.5px; letter-spacing:.1em; color:var(--ink-brand); animation:prBar .5s cubic-bezier(.16,1,.3,1) 1.85s both")}>
                    OPEN THE RECORD
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={css("flex:none")}>
                      <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"></path></svg></a>
                </div>
                </>) : null}
              </div>

              <div style={css("padding:var(--sp-7); display:flex; flex-direction:column; justify-content:center")}>
                <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--n-600)")}>04</div>
                <h3 style={css("margin:var(--sp-3) 0 0; font-size:32px; font-weight:600; letter-spacing:-.02em; line-height:1.14")}>Proof</h3>
                <p style={css("margin:var(--sp-4) 0 0; font-size:17px; color:var(--muted); max-width:380px")}>
                  Every transfer ends in a receipt: a reference you can quote, what each side sent and
                  received, and a link to the public record you can check yourself.</p>
                <a href="#" style={css("margin-top:var(--sp-6); display:inline-flex; align-items:center; gap:var(--sp-2); font-size:15px; font-weight:600; color:var(--ink-brand)")}>
                  What we publish
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"></path></svg></a>
              </div>
            </div>
  );
}
