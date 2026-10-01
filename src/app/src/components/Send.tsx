import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';

export default function Send({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Send" style={css("max-width:660px; margin:0 auto")}>

              
              <div style={css("display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-6)")}>
                {(v.stepRail || []).map((s: any, is: number) => (<React.Fragment key={is}>
                  <div style={css(s.wrap)}>
                    <span style={css(s.dot)}>{s.mark}</span>
                    <span style={css(s.bar)}></span>
                  </div>
                </React.Fragment>))}
              </div>

              <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-2); animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>

                
                {v.sf1 ? (<>
                  <div>
                    <h2 style={css("margin:0; font-size:24px; font-weight:600; letter-spacing:-.02em")}>Send money</h2>

                    <div style={css("margin-top:var(--sp-6); font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>You send</div>
                    <label style={css("margin-top:var(--sp-2); display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-4); background:var(--sunken); border:1px solid " + v.sndLine + "; border-radius:var(--r-sm); cursor:text")}>
                      <span style={css("font-family:var(--mono); font-size:24px; color:var(--muted)")}>&#8378;</span>
                      <input type="text" inputMode="numeric" value={v.sndText} onChange={v.onSnd} style={css("flex:1; min-width:0; background:transparent; border:none; outline:none; font-family:var(--mono); font-size:26px; font-weight:500; color:var(--text)")} />
                      <span style={css("font-family:var(--mono); font-size:13px; color:var(--muted)")}>TRY</span>
                    </label>
                    <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:11px; color:" + v.sndHintColor)}>{v.sndHint}</div>

                    <div style={css("margin-top:var(--sp-5); font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Corridor</div>
                    <div style={css("margin-top:var(--sp-3); display:grid; grid-template-columns:repeat(auto-fit, minmax(150px,1fr)); gap:var(--sp-2)")}>
                      {(v.corridors || []).map((c: any, ic: number) => (<React.Fragment key={ic}>
                        <button onClick={c.pick} style={css(c.style)}>
                          <span style={css(c.code)}>{c.iso}</span>
                          <span style={css("display:block; font-size:14.5px; font-weight:600; margin-top:var(--sp-2)")}>{c.name}</span>
                          <span style={css("display:block; font-family:var(--mono); font-size:11px; color:var(--muted); margin-top:2px")}>{c.cur}</span>
                        </button>
                      </React.Fragment>))}
                    </div>

                    <div style={css("margin-top:var(--sp-5); display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3)")}>
                      <span style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Recipient address</span>
                      <button onClick={v.useDemo} style={css("background:none; border:none; padding:0; cursor:pointer; font-size:13px; font-weight:600; color:var(--ink-brand)")}>Use a demo recipient</button>
                    </div>
                    <label style={css("margin-top:var(--sp-2); display:block; padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); cursor:text")}>
                      <input type="text" value={v.addrText} onChange={v.onAddr} placeholder="G…" style={css("width:100%; background:transparent; border:none; outline:none; font-family:var(--mono); font-size:13px; color:var(--text)")} />
                    </label>

                    <div style={css("margin-top:var(--sp-5); padding:var(--sp-4); background:var(--weak); border:1px solid var(--weak-line); border-radius:var(--r-sm); display:flex; flex-direction:column; gap:var(--sp-2)")}>
                      <div style={css(v.rowStyle)}>
                        <span style={css("color:var(--ink-brand)")}>Rate</span>
                        <span style={css("font-family:var(--mono); color:var(--ink-brand)")}>{v.rateTop}</span></div>
                      <div style={css(v.rowStyle)}>
                        <span style={css("color:var(--ink-brand)")}>Routed through</span>
                        <span style={css("font-family:var(--mono); color:var(--ink-brand)")}>{v.sndUsdc}</span></div>
                      <div style={css(v.rowStyle)}>
                        <span style={css("font-weight:600; color:var(--ink-brand)")}>{v.recvLabel}</span>
                        <span style={css("font-family:var(--mono); font-size:19px; font-weight:500; color:var(--ink-brand)")}>{v.sndOut}</span></div>
                    </div>
                    <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; color:var(--subtle)")}>ORACLE PRICE &middot; 50 BPS SPREAD &middot; TESTNET</div>

                    <button onClick={v.sndNext} disabled={v.sndNotReady} style={css(v.sndBtnStyle)}>Continue</button>
                  </div>
                </>) : null}

                
                {v.sf2 ? (<>
                  <div>
                    <h2 style={css("margin:0; font-size:22px; font-weight:600; letter-spacing:-.02em")}>Review and sign</h2>

                    <div style={css("margin-top:var(--sp-5); padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); display:flex; flex-direction:column; gap:var(--sp-3)")}>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>You send</span>
                        <span style={css("font-family:var(--mono); font-weight:500")}>{v.sndTry}</span></div>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Routed through</span>
                        <span style={css("font-family:var(--mono)")}>{v.sndUsdc}</span></div>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Locked rate</span>
                        <span style={css("font-family:var(--mono)")}>{v.rateTop}</span></div>
                      <div style={css("height:1px; background:var(--line)")}></div>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Destination</span>
                        <span>{v.pickName} ({v.pickCur})</span></div>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>They receive</span>
                        <span style={css("font-family:var(--mono); font-weight:500; color:var(--ink-brand)")}>{v.sndOut}</span></div>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Recipient</span>
                        <span style={css("font-family:var(--mono); font-size:13px")}>{v.addrShort}</span></div>
                    </div>

                    <div style={css("margin-top:var(--sp-4); padding:var(--sp-4); background:var(--weak); border:1px solid var(--weak-line); border-radius:var(--r-sm)")}>
                      <div style={css("font-size:15px; font-weight:600; color:var(--ink-brand)")}>You sign, we submit</div>
                      <p style={css("margin:var(--sp-2) 0 0; font-size:13.5px; color:var(--ink-brand)")}>
                        Your balance is already funded, so the signed transaction goes out immediately. Your
                        key never leaves your device — only the signed transaction reaches our
                        server.</p>
                    </div>

                    <div style={css("margin-top:var(--sp-4); display:flex; flex-direction:column; gap:var(--sp-2)")}>
                      <div style={css("display:flex; align-items:center; gap:var(--sp-2); font-family:var(--mono); font-size:11px; color:var(--muted)")}>
                        <span style={css("width:6px; height:6px; border-radius:50%; background:var(--brand)")}></span>Escrow: CCBV5…OTCE (testnet)</div>
                      <div style={css("font-family:var(--mono); font-size:11px; color:var(--subtle)")}>Saga: {v.sagaId}</div>
                    </div>

                    <div style={css("margin-top:var(--sp-5); display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:var(--sp-2)")}>
                      <button onClick={v.sndBack} style={css(v.ghostFlat)}>Back</button>
                      <button onClick={v.sndSign} style={css(v.ctaFlat)}>Sign and go</button>
                    </div>
                  </div>
                </>) : null}

                
                {v.sf3 ? (<>
                  <div style={css("padding:var(--sp-7) 0; text-align:center")}>
                    <div style={css("display:inline-block; width:48px; height:48px; border-radius:50%; border:3px solid var(--weak-line); border-top-color:var(--brand); animation:dSpin .9s linear infinite")}></div>
                    <div style={css("margin-top:var(--sp-5); font-size:18px; font-weight:600")}>Waiting for your
                      signature</div>
                    <div style={css("margin-top:var(--sp-2); font-size:14px; color:var(--muted)")}>Approve the
                      transaction in your wallet.</div>
                  </div>
                </>) : null}

                
                {v.sf4 ? (<>
                  <div>
                    <div style={css("display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3); flex-wrap:wrap")}>
                      <h2 style={css("margin:0; font-size:21px; font-weight:600; letter-spacing:-.02em")}>Tracking</h2>
                      <span style={css("font-family:var(--mono); font-size:15px; font-weight:500; color:var(--ink-brand); font-variant-numeric:tabular-nums")}>{v.elapsedLabel}</span>
                    </div>

                    <div style={css("margin-top:var(--sp-4); height:3px; border-radius:2px; background:var(--n-100); overflow:hidden")}>
                      <div style={css("height:100%; background:var(--brand); width:" + v.trackPct + "; transition:width .2s linear")}></div></div>

                    <div style={css("margin-top:var(--sp-5); display:grid; grid-template-columns:repeat(auto-fit, minmax(190px,1fr)); gap:var(--sp-3)")}>
                      <div style={css("padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm)")}>
                        <div style={css("display:flex; align-items:center; gap:var(--sp-2)")}>
                          <span style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; color:var(--muted)")}>TR</span>
                          <span style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Sender</span></div>
                        <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:19px; font-weight:500; font-variant-numeric:tabular-nums")}>{v.senderBal}</div></div>
                      <div style={css("padding:var(--sp-4); background:var(--weak); border:1px solid var(--weak-line); border-radius:var(--r-sm)")}>
                        <div style={css("display:flex; align-items:center; gap:var(--sp-2)")}>
                          <span style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; color:var(--ink-brand)")}>{v.pickIso}</span>
                          <span style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-brand)")}>Recipient</span></div>
                        <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:19px; font-weight:500; color:var(--ink-brand); font-variant-numeric:tabular-nums")}>{v.recvBal}</div></div>
                    </div>

                    <div style={css("margin-top:var(--sp-5); display:flex; flex-direction:column; gap:var(--sp-1)")}>
                      {(v.trackSteps || []).map((t: any, it: number) => (<React.Fragment key={it}>
                        <div style={css(t.style)}>
                          <span style={css(t.dot)}>{t.mark}</span>
                          <span style={css("font-size:14.5px; font-weight:" + t.weight)}>{t.label}</span>
                          <span style={css("margin-left:auto; font-family:var(--mono); font-size:11px; color:var(--subtle)")}>{t.at}</span>
                        </div>
                      </React.Fragment>))}
                    </div>
                  </div>
                </>) : null}

                
                {v.sf5 ? (<>
                  <div style={css("text-align:center")}>
                    <div style={css("display:inline-grid; place-items:center; width:52px; height:52px; border-radius:50%; background:var(--brand)")}>
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                        <path d="M6 12.5l4 4 8-8.5" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="26" strokeDashoffset="26" style={css("animation:dCheck .5s cubic-bezier(.16,1,.3,1) .1s both")}></path></svg>
                    </div>
                    <div style={css("margin-top:var(--sp-4); font-size:20px; font-weight:600")}>Transfer
                      complete</div>
                    <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:24px; font-weight:500; color:var(--ink-brand)")}>{v.sndOut}</div>

                    <div style={css("margin-top:var(--sp-6); text-align:left")}>
                      <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Time per step</div>
                      <div style={css("margin-top:var(--sp-3); display:flex; flex-direction:column; gap:var(--sp-3)")}>
                        {(v.timings || []).map((b: any, ib: number) => (<React.Fragment key={ib}>
                          <div>
                            <div style={css("display:flex; justify-content:space-between; gap:var(--sp-3); font-size:13px; margin-bottom:var(--sp-1)")}>
                              <span style={css("color:" + b.labelColor)}>{b.label}</span>
                              <span style={css("font-family:var(--mono); color:" + b.labelColor)}>{b.val}</span></div>
                            <div style={css("height:6px; border-radius:var(--r-xs); background:var(--n-100); overflow:hidden")}>
                              <div style={css(b.fill)}></div></div>
                          </div>
                        </React.Fragment>))}
                      </div>
                    </div>

                    <div style={css("margin-top:var(--sp-5); text-align:left; padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); display:flex; flex-direction:column; gap:var(--sp-2)")}>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Transaction</span>
                        <span style={css("font-family:var(--mono); font-size:13px")}>{v.txHash}</span></div>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Ledger</span>
                        <span style={css("font-family:var(--mono); font-size:13px")}>{v.ledger}</span></div>
                      <div style={css(v.rowStyle)}><span style={css("color:var(--muted)")}>Network fee</span>
                        <span style={css("font-family:var(--mono); font-size:13px")}>0.0000100 XLM</span></div>
                    </div>

                    <a href="https://stellar.expert" target="_blank" rel="noopener" style={css("margin-top:var(--sp-3); display:flex; align-items:center; justify-content:space-between; gap:var(--sp-3); padding:var(--sp-4); background:var(--weak); border:1px solid var(--weak-line); border-radius:var(--r-sm); font-family:var(--mono); font-size:11px; letter-spacing:.08em; color:var(--ink-brand)")}>
                      VERIFY ON STELLAR.EXPERT
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={css("flex:none")}>
                        <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"></path></svg></a>

                    <div style={css("margin-top:var(--sp-5); display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:var(--sp-2)")}>
                      <button onClick={v.sndAgain} style={css(v.ghostFlat)}>Send another</button>
                      <button onClick={v.goHistory} style={css(v.ghostFlat)}>History</button>
                      <button onClick={v.goYield} style={css(v.ghostFlat)}>Put it to work</button>
                    </div>
                  </div>
                </>) : null}
              </div>
            </div>
  );
}
