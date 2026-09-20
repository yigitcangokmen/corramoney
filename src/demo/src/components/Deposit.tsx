import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';

export default function Deposit({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Deposit" style={css("max-width:620px; margin:0 auto; animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>

              
              {v.depForm ? (<>
                <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-2)")}>
                  <h2 style={css("margin:0; font-size:24px; font-weight:600; letter-spacing:-.02em")}>Deposit TRY</h2>
                  <p style={css("margin:var(--sp-3) 0 0; font-size:15px; color:var(--muted)")}>
                    Send a bank transfer and your balance lands in the app.</p>

                  <div style={css("margin-top:var(--sp-6); font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Amount</div>
                  <label style={css("margin-top:var(--sp-2); display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-4); background:var(--sunken); border:1px solid " + v.depLine + "; border-radius:var(--r-sm); cursor:text")}>
                    <span style={css("font-family:var(--mono); font-size:24px; color:var(--muted)")}>&#8378;</span>
                    <input type="text" inputMode="numeric" value={v.depText} onChange={v.onDep} style={css("flex:1; min-width:0; background:transparent; border:none; outline:none; font-family:var(--mono); font-size:26px; font-weight:500; color:var(--text)")} />
                    <span style={css("font-family:var(--mono); font-size:13px; color:var(--muted)")}>TRY</span>
                  </label>
                  <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:11px; color:" + v.depHintColor)}>{v.depHint}</div>

                  <div style={css("display:flex; gap:var(--sp-2); margin-top:var(--sp-3); flex-wrap:wrap")}>
                    <button onClick={v.depA} style={css(v.chipStyle)}>&#8378;500</button>
                    <button onClick={v.depB} style={css(v.chipStyle)}>&#8378;1,000</button>
                    <button onClick={v.depC} style={css(v.chipStyle)}>&#8378;3,000</button>
                  </div>

                  <div style={css("margin-top:var(--sp-5); padding:var(--sp-4); background:var(--weak); border:1px solid var(--weak-line); border-radius:var(--r-sm); display:flex; justify-content:space-between; align-items:baseline; gap:var(--sp-3)")}>
                    <span style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-brand)")}>Lands in your balance</span>
                    <span style={css("font-family:var(--mono); font-size:22px; font-weight:500; color:var(--ink-brand); font-variant-numeric:tabular-nums")}>{v.depUsdc}</span>
                  </div>

                  <button onClick={v.depGo} disabled={v.depNotReady} style={css(v.depBtnStyle)}>Get transfer details</button>
                </div>
              </>) : null}

              
              {v.depWaiting ? (<>
                <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-2); animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>
                  <div style={css("display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3); flex-wrap:wrap")}>
                    <h2 style={css("margin:0; font-size:22px; font-weight:600; letter-spacing:-.02em")}>Send the transfer</h2>
                    <span style={css("font-family:var(--mono); font-size:11px; letter-spacing:.1em; color:var(--muted)")}>{v.depRef}</span>
                  </div>

                  <div style={css("margin-top:var(--sp-5); padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm)")}>
                    <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>IBAN</div>
                    <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:14px; font-weight:500; word-break:break-all")}>TR48 0006 2000 1230 0006 8412 77</div>
                    <div style={css("margin-top:var(--sp-2); font-size:13px; color:var(--muted)")}>Anchor
                      Bank A.Ş. &middot; Mock anchor (testnet)</div>
                  </div>

                  <div style={css("margin-top:var(--sp-3); padding:var(--sp-4); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-sm)")}>
                    <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--amber)")}>Reference &middot; required</div>
                    <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:17px; font-weight:500; color:var(--amber)")}>{v.depRefCode}</div>
                    <div style={css("margin-top:var(--sp-2); font-size:13px; color:var(--amber)")}>This code
                      ties your transfer to your account. Without it nothing matches.</div>
                  </div>

                  <div style={css("margin-top:var(--sp-3); display:grid; grid-template-columns:repeat(auto-fit, minmax(150px,1fr)); gap:var(--sp-3)")}>
                    <div style={css("padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm)")}>
                      <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Amount</div>
                      <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:17px; font-weight:500")}>{v.depTry}</div></div>
                    <div style={css("padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm)")}>
                      <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>You get</div>
                      <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:17px; font-weight:500; color:var(--ink-brand)")}>{v.depUsdc}</div></div>
                  </div>

                  <div style={css("margin-top:var(--sp-5); display:flex; align-items:center; justify-content:center; gap:var(--sp-3); padding:var(--sp-4); border:1px dashed var(--line-strong); border-radius:var(--r-sm)")}>
                    <span style={css("width:16px; height:16px; border-radius:50%; border:2px solid var(--weak-line); border-top-color:var(--brand); animation:dSpin 1s linear infinite")}></span>
                    <span style={css("font-family:var(--mono); font-size:12px; letter-spacing:.06em; color:var(--muted)")}>Waiting for the transfer</span>
                  </div>

                  <button onClick={v.depSim} style={css(v.ctaStyle)}>Simulate the transfer (demo)</button>
                  <button onClick={v.depBack} style={css(v.ghostStyle)}>Back</button>
                </div>
              </>) : null}

              
              {v.depClearing ? (<>
                <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-9) var(--sp-6); box-shadow:var(--e-2); text-align:center")}>
                  <div style={css("display:inline-block; width:48px; height:48px; border-radius:50%; border:3px solid var(--weak-line); border-top-color:var(--brand); animation:dSpin .9s linear infinite")}></div>
                  <div style={css("margin-top:var(--sp-5); font-size:18px; font-weight:600")}>Matching your
                    transfer</div>
                  <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:12.5px; color:var(--muted)")}>{v.depRefCode} &middot; {v.depTry}</div>
                  <div style={css("margin-top:var(--sp-6); height:3px; border-radius:2px; background:var(--n-100); overflow:hidden")}>
                    <div style={css("height:100%; background:var(--brand); width:" + v.depProg + "; transition:width .25s linear")}></div></div>
                </div>
              </>) : null}

              
              {v.depDone ? (<>
                <div style={css("background:var(--surface); border:1px solid var(--weak-line); border-radius:var(--r-lg); padding:var(--sp-7) var(--sp-6); box-shadow:var(--e-3); text-align:center; animation:dRise .4s cubic-bezier(.16,1,.3,1) both")}>
                  <div style={css("display:inline-grid; place-items:center; width:52px; height:52px; border-radius:50%; background:var(--brand)")}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                      <path d="M6 12.5l4 4 8-8.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="26" strokeDashoffset="26" style={css("animation:dCheck .5s cubic-bezier(.16,1,.3,1) .1s both")}></path></svg>
                  </div>
                  <div style={css("margin-top:var(--sp-4); font-size:20px; font-weight:600")}>Your balance
                    is ready</div>

                  <div style={css("margin-top:var(--sp-5); text-align:left; padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); display:flex; flex-direction:column; gap:var(--sp-2)")}>
                    <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Deposited</span>
                      <span style={css("font-family:var(--mono); font-weight:500")}>{v.depTry}</span></div>
                    <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Received</span>
                      <span style={css("font-family:var(--mono); font-weight:500; color:var(--ink-brand)")}>{v.depUsdc}</span></div>
                    <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Rate</span>
                      <span style={css("font-family:var(--mono)")}>{v.rateTop}</span></div>
                  </div>

                  <div style={css("margin-top:var(--sp-5); display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:var(--sp-2)")}>
                    <button onClick={v.depAgain} style={css(v.ghostFlat)}>Deposit again</button>
                    <button onClick={v.goSend} style={css(v.ctaFlat)}>Send it now</button>
                    <button onClick={v.goYield} style={css(v.ghostFlat)}>Put it to work</button>
                  </div>
                </div>
              </>) : null}
            </div>
  );
}
