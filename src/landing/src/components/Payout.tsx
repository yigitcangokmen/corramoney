import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function Payout({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Payout" style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); box-shadow:var(--e-1); overflow:hidden; display:grid; grid-template-columns:repeat(auto-fit, minmax(300px,1fr))")}>

              <div style={css("position:relative; background:var(--sunken); border-right:1px solid var(--line); min-height:352px; display:flex; align-items:center; justify-content:center; padding:var(--sp-6); overflow:hidden")}>

                <div style={css(v.pvWash)}></div>

                <div style={css("position:relative; z-index:2; width:100%; max-width:290px")}>

                  
                  <div style={css(v.pvSel)}>
                    {v.pvTapSel ? (<>
                      <span style={css("position:absolute; left:50%; top:50%; width:150%; aspect-ratio:1; border-radius:50%; background:var(--brand); pointer-events:none; animation:pvRipple .7s cubic-bezier(.16,1,.3,1) both")}></span>
                      <span style={css("position:absolute; inset:-1px; border-radius:var(--r-sm); border:2px solid var(--brand); pointer-events:none; animation:pvHit .7s cubic-bezier(.16,1,.3,1) both")}></span>
                    </>) : null}
                    <div style={css("position:relative; flex:1; min-width:0; height:21px")}>
                      {v.pvNoPick ? (<>
                        <span style={css("position:absolute; inset:0; font-size:15px; color:var(--muted)")}>Select a destination</span>
                      </>) : null}
                      {v.pvPicked ? (<>
                        <span style={css("position:absolute; inset:0; display:flex; align-items:center; gap:var(--sp-3); animation:pvFade .3s cubic-bezier(.16,1,.3,1) both")}>
                          <span style={css("flex:none; width:21px; height:21px; border-radius:50%; display:grid; place-items:center; background:conic-gradient(from 214deg,var(--flag-ph-blue) 0 40%,var(--flag-ph-red) 40% 80%,#fff 80% 100%)")}>
                            <span style={css("width:16px; height:16px; border-radius:50%; background:var(--n-0); display:grid; place-items:center; font-family:var(--mono); font-size:10.5px; font-weight:500; color:var(--n-900)")}>&#8369;</span></span>
                          <span style={css("font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap")}>Bank account PHP</span>
                        </span>
                      </>) : null}
                    </div>
                    <span style={css(v.pvChev)}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={css("display:block")}>
                        <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"></path></svg></span>
                  </div>

                  
                  {v.pvListOpen ? (<>
                    <div style={css("margin-top:var(--sp-2); background:var(--surface); border:1px solid var(--line-strong); border-radius:var(--r-sm); box-shadow:var(--e-3); overflow:hidden")}>

                      <div style={css(v.pvRow1)}>
                        <span style={css("flex:none; width:26px; height:26px; border-radius:50%; background:var(--weak); border:1px solid var(--weak-line); color:var(--ink-brand); display:grid; place-items:center")}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={css("display:block")}>
                            <rect x="2.6" y="6" width="18.8" height="12.6" rx="2.4" stroke="currentColor" strokeWidth="1.9"></rect>
                            <path d="M15.6 12.3h5.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"></path></svg></span>
                        <span style={css("min-width:0")}>
                          <span style={css("display:block; font-size:13.5px; font-weight:500")}>GCash wallet</span>
                          <span style={css("display:block; font-family:var(--mono); font-size:10.5px; color:var(--n-600)")}>&middot;&middot;&middot;81fe</span></span>
                      </div>

                      <div style={css(v.pvRow2)}>
                        <span style={css("flex:none; width:26px; height:26px; border-radius:50%; background:var(--weak); border:1px solid var(--weak-line); color:var(--ink-brand); display:grid; place-items:center")}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={css("display:block")}>
                            <path d="M3.4 9.2l1.5-4.4h14.2l1.5 4.4M3.4 9.2v10.2h17.2V9.2M9.6 19.4v-5.6h4.8v5.6" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round"></path></svg></span>
                        <span style={css("min-width:0")}>
                          <span style={css("display:block; font-size:13.5px; font-weight:500")}>Cash pickup</span>
                          <span style={css("display:block; font-family:var(--mono); font-size:10.5px; color:var(--n-600)")}>Manila &middot; over the counter</span></span>
                      </div>

                      <div style={css(v.pvRow3)}>
                        {v.pvTapRow ? (<>
                          <span style={css("position:absolute; left:50%; top:50%; width:110%; aspect-ratio:1; border-radius:50%; background:var(--brand); pointer-events:none; animation:pvRipple .7s cubic-bezier(.16,1,.3,1) both")}></span>
                          <span style={css("position:absolute; inset:0; border:2px solid var(--brand); pointer-events:none; animation:pvHit .7s cubic-bezier(.16,1,.3,1) both")}></span>
                        </>) : null}
                        <span style={css(v.pvDot3)}>
                          <span style={css("width:18px; height:18px; border-radius:50%; background:var(--n-0); display:grid; place-items:center; font-family:var(--mono); font-size:10.5px; font-weight:500; color:var(--n-900)")}>&#8369;</span></span>
                        <span style={css("min-width:0")}>
                          <span style={css("display:block; font-size:13.5px; font-weight:500")}>Bank account PHP</span>
                          <span style={css("display:block; font-family:var(--mono); font-size:10.5px; color:var(--n-600)")}>&middot;&middot;&middot;6448 &middot; InstaPay</span></span>
                        {v.pvShowTick ? (<>
                          <span style={css("margin-left:auto; flex:none; display:block; animation:pvTick .4s cubic-bezier(.16,1,.3,1) both")}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={css("display:block")}>
                              <path d="M6 12.5l4 4 8-8.5" stroke="var(--brand)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"></path></svg></span>
                        </>) : null}
                      </div>
                    </div>
                  </>) : null}

                  
                  <div style={css(v.pvAmt)}>
                    <div style={css("display:flex; justify-content:space-between; gap:var(--sp-3); font-size:13px; padding:var(--sp-3) 0; border-bottom:1px solid var(--line)")}>
                      <span style={css("color:var(--muted)")}>Amount</span>
                      <span style={css("font-family:var(--mono); font-weight:500")}>&#8369;4,050.02</span></div>
                    <div style={css("display:flex; justify-content:space-between; gap:var(--sp-3); font-size:13px; padding:var(--sp-3) 0")}>
                      <span style={css("color:var(--muted)")}>Arrives</span>
                      <span style={css("font-family:var(--mono)")}>seconds &middot; InstaPay</span></div>
                  </div>

                  
                  <div style={css(v.pvPress)}>
                    <div style={css(v.pvBtn)}>
                      {v.pvTapBtn ? (<>
                        <span style={css("position:absolute; left:50%; top:50%; width:110%; aspect-ratio:1; border-radius:50%; background:#fff; pointer-events:none; z-index:4; animation:pvRipple .7s cubic-bezier(.16,1,.3,1) both")}></span>
                      </>) : null}
                      {v.pvDone ? (<>
                        <span style={css("position:absolute; top:0; bottom:0; left:0; width:44%; z-index:3; pointer-events:none; background:linear-gradient(104deg, transparent, rgba(255,255,255,.3), transparent); animation:pvSheen 1s linear both")}></span>
                      </>) : null}

                      {v.pvIdle ? (<>
                        <span style={css("display:flex; align-items:center; justify-content:center")}>Withdraw &#8369;4,050.02</span>
                      </>) : null}
                      {v.pvSending ? (<>
                        <span style={css("display:flex; align-items:center; justify-content:center; gap:var(--sp-3); animation:pvFade .25s linear both")}>
                          <span style={css("display:block; width:14px; height:14px; border-radius:50%; border:2px solid rgba(255,255,255,.4); border-top-color:#fff; animation:spin 1.05s linear infinite")}></span>Sending</span>
                      </>) : null}
                      {v.pvDone ? (<>
                        <span style={css("display:flex; align-items:center; justify-content:center; gap:var(--sp-2); animation:pvFade .25s linear both")}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={css("display:block")}>
                            <path d="M6 12.5l4 4 8-8.5" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="26" strokeDashoffset="26" style={css("animation:pvCheck .5s cubic-bezier(.16,1,.3,1) .06s both")}></path></svg>
                          Completed</span>
                      </>) : null}

                      <span style={css(v.pvBar)}></span>
                    </div>
                    {v.pvDone ? (<>
                      <span style={css("position:absolute; inset:0; border-radius:var(--r-sm); border:2px solid var(--green-400); pointer-events:none; animation:pvRing .9s cubic-bezier(.16,1,.3,1) both")}></span>
                    </>) : null}
                  </div>

                  
                  <div style={css("height:19px; margin-top:var(--sp-3); display:flex; align-items:center; justify-content:center")}>
                    {v.pvHasStatus ? (<>
                      <span style={css("display:inline-flex; align-items:center; gap:var(--sp-2); font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; color:" + v.pvStatusColor)}>
                        <span style={css(v.pvStatusDot)}></span>{v.pvStatusText}</span>
                    </>) : null}
                  </div>
                </div>
              </div>

              <div style={css("padding:var(--sp-7); display:flex; flex-direction:column; justify-content:center")}>
                <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--n-600)")}>02</div>
                <h3 style={css("margin:var(--sp-3) 0 0; font-size:32px; font-weight:600; letter-spacing:-.02em; line-height:1.14")}>Payout</h3>
                <p style={css("margin:var(--sp-4) 0 0; font-size:17px; color:var(--muted); max-width:380px")}>
                  The recipient picks how they want it: straight to a bank account, or cash over the
                  counter. Either way the amount is the one that was quoted.</p>
                <a href="#" style={css("margin-top:var(--sp-6); display:inline-flex; align-items:center; gap:var(--sp-2); font-size:15px; font-weight:600; color:var(--ink-brand)")}>
                  Payout options
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"></path></svg></a>
              </div>
            </div>
  );
}
