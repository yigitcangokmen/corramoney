import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function CashIn({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Cash-in" style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); box-shadow:var(--e-1); overflow:hidden; display:grid; grid-template-columns:repeat(auto-fit, minmax(300px,1fr))")}>

              <div style={css("order:1; padding:var(--sp-7); display:flex; flex-direction:column; justify-content:center")}>
                <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--n-600)")}>01</div>
                <h3 style={css("margin:var(--sp-3) 0 0; font-size:32px; font-weight:600; letter-spacing:-.02em; line-height:1.14")}>Cash-in</h3>
                <p style={css("margin:var(--sp-4) 0 0; font-size:17px; color:var(--muted); max-width:380px")}>
                  You send an ordinary bank transfer from the app you already use. The reference code
                  in the description is what ties the money to your account, so it is the one field
                  that matters.</p>
                <a href="#" style={css("margin-top:var(--sp-6); display:inline-flex; align-items:center; gap:var(--sp-2); font-size:15px; font-weight:600; color:var(--ink-brand)")}>
                  How deposits work
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"></path></svg></a>
              </div>

              <div style={css("position:relative; order:2; background:var(--sunken); border-left:1px solid var(--line); min-height:352px; display:flex; align-items:center; justify-content:center; padding:var(--sp-6); overflow:hidden")}>
                <div style={css(v.ciWash)}></div>

                <div style={css("position:relative; z-index:2; width:100%; max-width:316px")}>

                  
                  {v.ciForm ? (<>
                    <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-2); animation:ciIn .42s cubic-bezier(.16,1,.3,1) both")}>

                      <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--n-600)")}>Send a bank transfer to</div>

                      <div style={css(v.ciF1)}>
                        <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>IBAN</div>
                        <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:13px; font-weight:500; letter-spacing:.01em")}>{v.ciIban}<i style={css(v.ciIbanCaret)}></i></div>
                      </div>

                      <div style={css(v.ciF2)}>
                        <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-brand); white-space:nowrap")}>Description &middot; required</div>
                        <div style={css("display:flex; align-items:center; gap:var(--sp-2); margin-top:var(--sp-1)")}>
                          <span style={css("font-family:var(--mono); font-size:17px; font-weight:500; color:var(--ink-brand)")}>CORRA-8412-TRY</span>
                          <span style={css("margin-left:auto; flex:none; display:block; color:var(--ink-brand)")}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={css("display:block")}>
                              <rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2" stroke="currentColor" strokeWidth="1.9"></rect>
                              <path d="M15.6 5.4H6.4a2 2 0 00-2 2v9.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"></path></svg></span>
                        </div>
                      </div>

                      <div style={css(v.ciF3)}>
                        <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Amount</div>
                        <div style={css("font-family:var(--mono); font-size:22px; font-weight:500; font-variant-numeric:tabular-nums; margin-top:var(--sp-1)")}>{v.ciAmt}<i style={css(v.ciAmtCaret)}></i></div>
                      </div>

                      <div style={css(v.ciBtn)}>
                        {v.ciTap ? (<>
                          <span style={css("position:absolute; left:50%; top:50%; width:110%; aspect-ratio:1; border-radius:50%; background:#fff; pointer-events:none; z-index:3; animation:ciRipple .7s cubic-bezier(.16,1,.3,1) both")}></span>
                        </>) : null}
                        {v.ciSending ? (<>
                          <span style={css("display:flex; align-items:center; justify-content:center; gap:var(--sp-3); animation:ciFade .25s linear both")}>
                            <span style={css("display:block; width:14px; height:14px; border-radius:50%; border:2px solid rgba(255,255,255,.4); border-top-color:#fff; animation:spin 1.05s linear infinite")}></span>Waiting for the bank</span>
                        </>) : null}
                        {v.ciIdle ? (<>
                          <span>I have sent it</span>
                        </>) : null}
                      </div>
                    </div>
                  </>) : null}

                  
                  {v.ciDone ? (<>
                    <div style={css("background:var(--surface); border:1px solid var(--weak-line); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-3); display:flex; gap:var(--sp-4); position:relative; overflow:hidden; animation:ciIn .46s cubic-bezier(.16,1,.3,1) both")}>
                      <span style={css("position:absolute; top:0; bottom:0; left:0; width:42%; z-index:3; pointer-events:none; background:linear-gradient(104deg, transparent, rgba(47,203,114,.22), transparent); animation:ciSheen 1.1s linear .28s both")}></span>
                      <span style={css("position:absolute; left:-30px; bottom:-40px; width:150px; height:150px; border-radius:50%; pointer-events:none; background:radial-gradient(circle, rgba(47,203,114,.22) 0%, rgba(47,203,114,.06) 45%, rgba(47,203,114,0) 72%); animation:ciGlow .8s linear .34s both")}></span>

                      <div style={css("position:relative; z-index:2; flex:none; width:40px; height:40px")}>
                        <div style={css("width:40px; height:40px; border-radius:50%; display:grid; place-items:center; background:conic-gradient(from 300deg,var(--flag-tr) 0 44%,#fff 44% 60%,var(--flag-tr) 60% 100%)")}>
                          <span style={css("width:31px; height:31px; border-radius:50%; background:var(--n-0); display:grid; place-items:center; font-family:var(--mono); font-size:15px; font-weight:500; color:var(--n-900)")}>&#8378;</span></div>
                        <span style={css("position:absolute; right:-3px; bottom:-3px; width:19px; height:19px; border-radius:50%; border:2px solid var(--green-400); pointer-events:none; animation:ciRing .9s cubic-bezier(.16,1,.3,1) .3s both")}></span>
                        <span style={css("position:absolute; right:-3px; bottom:-3px; width:19px; height:19px; border-radius:50%; background:var(--brand); border:2px solid var(--surface); display:grid; place-items:center")}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={css("display:block")}>
                            <path d="M6 12.5l4 4 8-8.5" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="26" strokeDashoffset="26" style={css("animation:ciCheck .5s cubic-bezier(.16,1,.3,1) .2s both")}></path></svg>
                        </span>
                      </div>

                      <div style={css("position:relative; z-index:2; min-width:0; flex:1")}>
                        <div style={css("font-size:15px; font-weight:600")}>Deposit matched</div>
                        <div style={css("margin-top:var(--sp-1); font-size:13.5px; color:var(--muted)")}>
                          &#8378;3,500.00 is in your Corra balance and ready to send.</div>
                        <div style={css("margin-top:var(--sp-3); font-family:var(--mono); font-size:10.5px; letter-spacing:.1em; color:var(--n-600)")}>CORRA-8412-TRY &middot; 4 MIN 12 S</div>
                      </div>
                    </div>
                  </>) : null}
                </div>
              </div>
            </div>
  );
}
