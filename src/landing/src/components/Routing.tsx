import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function Routing({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Routing" style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); box-shadow:var(--e-1); overflow:hidden; display:grid; grid-template-columns:repeat(auto-fit, minmax(300px,1fr))")}>

              <div style={css("padding:var(--sp-7); display:flex; flex-direction:column; justify-content:center")}>
                <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--n-600)")}>03</div>
                <h3 style={css("margin:var(--sp-3) 0 0; font-size:32px; font-weight:600; letter-spacing:-.02em; line-height:1.14")}>Routing</h3>
                <p style={css("margin:var(--sp-4) 0 0; font-size:17px; color:var(--muted); max-width:380px")}>
                  Once your lira is on Stellar it reaches the peso token through a dollar-pegged asset,
                  priced at the moment you confirm. One operation, one signature: either the full
                  amount lands or nothing moves.</p>
                <a href="#" style={css("margin-top:var(--sp-6); display:inline-flex; align-items:center; gap:var(--sp-2); font-size:15px; font-weight:600; color:var(--ink-brand)")}>
                  See the route
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"></path></svg></a>
              </div>

              <div style={css("background:var(--sunken); border-left:1px solid var(--line); min-height:352px; display:flex; align-items:center; justify-content:center; padding:var(--sp-6); overflow:hidden")}>
                <div style={css("position:relative; width:100%; max-width:380px; height:252px")}>

                  
                  {v.rtCardOn ? (<>
                  <div style={css(v.rtCardStyle)}>
                    {v.rtLeg1 ? (<>
                      <div style={css("font-family:var(--mono); font-size:10.5px; font-weight:500; letter-spacing:.12em; color:var(--muted); font-size:10.5px")}>TRY.T -&gt; USDC</div>
                      <div style={css("margin-top:var(--sp-2); height:34px; display:flex; align-items:center; justify-content:center; gap:var(--sp-3)")}>
                        <span style={css("width:34px; height:34px; border-radius:50%; flex:none; display:grid; place-items:center; animation:rtPop .38s cubic-bezier(.5,.05,.3,1) both; background:conic-gradient(from 300deg,var(--flag-tr) 0 44%,#fff 44% 60%,var(--flag-tr) 60% 100%)")}>
                          <span style={css("width:26px; height:26px; border-radius:50%; background:var(--n-0); display:grid; place-items:center; font-family:var(--mono); font-size:13px; font-weight:500; color:var(--n-900)")}>&#8378;</span></span>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={css("color:var(--ink-brand); flex:none; " + v.rtArrow1)}>
                          <path d="M4 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"></path></svg>
                        <span style={css("width:34px; height:34px; flex:none; display:block")}>
                          {v.rtHitHub ? (<>
                            <span style={css("display:block; width:34px; height:34px; border-radius:50%; overflow:hidden; animation:rtSpin .46s cubic-bezier(.4,.1,.3,1.4) both")}>
                              <svg viewBox="0 0 2000 2000" style={css("width:100%; height:100%; display:block")}>
                                <circle cx="1000" cy="1000" r="1000" fill="var(--asset-usdc)"></circle>
                                <path fill="#fff" d="M1275 1158c0-146-88-196-263-217-125-17-150-50-150-108s42-96 125-96c75 0 117 25 138 88 4 13 17 21 29 21h67c17 0 29-12 29-29v-4c-16-92-92-163-188-171v-100c0-17-12-29-33-33h-63c-17 0-29 12-33 33v96c-125 17-204 100-204 208 0 138 83 192 258 213 117 17 154 42 154 108s-58 112-137 112c-108 0-146-46-158-108-4-17-17-25-29-25h-71c-17 0-29 12-29 29v4c17 104 83 179 221 200v100c0 17 12 29 33 33h63c17 0 29-12 33-33v-100c125-21 208-108 208-225z"></path>
                                <path fill="#fff" d="M792 1596c-325-117-492-479-371-800 63-171 196-300 371-363 17-8 25-21 25-42v-58c0-17-8-29-25-33-4 0-13 0-17 4-396 125-613 546-488 942 75 233 254 412 488 488 17 8 33 0 37-17 4-4 4-8 4-17v-58c0-12-12-29-24-37zM1245 383c-17-8-33 0-37 17-4 4-4 8-4 17v58c0 17 12 33 25 42 325 117 492 479 371 800-63 171-196 300-371 362-17 8-25 21-25 42v58c0 17 8 29 25 33 4 0 13 0 17-4 396-125 613-546 488-942-75-238-258-417-489-483z"></path>
                              </svg></span>
                          </>) : null}
                        </span>
                      </div>
                    </>) : null}

                    {v.rtLeg2 ? (<>
                      <div style={css("font-family:var(--mono); font-size:10.5px; font-weight:500; letter-spacing:.12em; color:var(--muted); font-size:10.5px")}>USDC -&gt; PHP.T</div>
                      <div style={css("margin-top:var(--sp-2); height:34px; display:flex; align-items:center; justify-content:center; gap:var(--sp-3)")}>
                        <span style={css("width:34px; height:34px; flex:none; display:block; animation:rtPop .38s cubic-bezier(.5,.05,.3,1) both")}>
                          <svg viewBox="0 0 2000 2000" style={css("width:100%; height:100%; display:block")}>
                            <circle cx="1000" cy="1000" r="1000" fill="var(--asset-usdc)"></circle>
                            <path fill="#fff" d="M1275 1158c0-146-88-196-263-217-125-17-150-50-150-108s42-96 125-96c75 0 117 25 138 88 4 13 17 21 29 21h67c17 0 29-12 29-29v-4c-16-92-92-163-188-171v-100c0-17-12-29-33-33h-63c-17 0-29 12-33 33v96c-125 17-204 100-204 208 0 138 83 192 258 213 117 17 154 42 154 108s-58 112-137 112c-108 0-146-46-158-108-4-17-17-25-29-25h-71c-17 0-29 12-29 29v4c17 104 83 179 221 200v100c0 17 12 29 33 33h63c17 0 29-12 33-33v-100c125-21 208-108 208-225z"></path>
                            <path fill="#fff" d="M792 1596c-325-117-492-479-371-800 63-171 196-300 371-363 17-8 25-21 25-42v-58c0-17-8-29-25-33-4 0-13 0-17 4-396 125-613 546-488 942 75 233 254 412 488 488 17 8 33 0 37-17 4-4 4-8 4-17v-58c0-12-12-29-24-37zM1245 383c-17-8-33 0-37 17-4 4-4 8-4 17v58c0 17 12 33 25 42 325 117 492 479 371 800-63 171-196 300-371 362-17 8-25 21-25 42v58c0 17 8 29 25 33 4 0 13 0 17-4 396-125 613-546 488-942-75-238-258-417-489-483z"></path>
                          </svg></span>
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={css("color:var(--ink-brand); flex:none; " + v.rtArrow2)}>
                          <path d="M4 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"></path></svg>
                        <span style={css("width:34px; height:34px; flex:none; display:block")}>
                          {v.rtHitEnd ? (<>
                            <span style={css("display:block; width:34px; height:34px; border-radius:50%; display:grid; place-items:center; animation:rtSpin .46s cubic-bezier(.4,.1,.3,1.4) both; background:conic-gradient(from 214deg,var(--flag-ph-blue) 0 40%,var(--flag-ph-red) 40% 80%,#fff 80% 100%)")}>
                              <span style={css("width:26px; height:26px; border-radius:50%; background:var(--n-0); display:grid; place-items:center; font-family:var(--mono); font-size:13px; font-weight:500; color:var(--n-900)")}>&#8369;</span></span>
                          </>) : null}
                        </span>
                      </div>
                    </>) : null}
                  </div>
                  </>) : null}

                  <svg viewBox="0 0 380 252" width="100%" height="252" style={css("display:block")}>
                    <path d="M62 144 H318" stroke="var(--line-strong)" strokeWidth="1.6" fill="none"></path>
                    <path d="M62 144 H318" stroke="var(--brand)" strokeWidth="1.8" fill="none" strokeDasharray="5 6" style={css("animation:route-dash 1.4s linear infinite")}></path>
                  </svg>

                  
                  <div style={css(v.rtPacketStyle)}>
                    <span style={css(v.rtPacketInner)}>{v.rtPacketGlyph}</span></div>

                  
                  <div style={css("position:absolute; left:62px; top:144px; transform:translate(-50%,-50%); width:40px; height:40px; border-radius:50%; display:grid; place-items:center; box-shadow:var(--e-2); background:conic-gradient(from 300deg,var(--flag-tr) 0 44%,#fff 44% 60%,var(--flag-tr) 60% 100%)")}>
                    <span style={css("width:31px; height:31px; border-radius:50%; background:var(--n-0); display:grid; place-items:center; font-family:var(--mono); font-size:15px; font-weight:500; color:var(--n-900)")}>&#8378;</span>
                  </div>
                  <div style={css("position:absolute; left:62px; top:174px; transform:translateX(-50%); text-align:center; white-space:nowrap")}>
                    <div style={css("font-family:var(--mono); font-size:12px; font-weight:500; letter-spacing:.06em")}>TRY.T</div>
                    <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:10.5px; color:var(--muted)")}>&#8378;3,500.00</div>
                  </div>

                  
                  <div style={css("position:absolute; left:190px; top:174px; transform:translateX(-50%); text-align:center; white-space:nowrap")}>
                    <div style={css("font-family:var(--mono); font-size:12px; font-weight:500; letter-spacing:.06em")}>USDC</div>
                    <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:10.5px; color:var(--muted)")}>71.6 USDC</div>
                  </div>
                  <div style={css("position:absolute; left:190px; top:144px; transform:translate(-50%,-50%); width:44px; height:44px; border-radius:50%; box-shadow:var(--e-2)")}>
                    {v.rtFlash1 ? (<>
                      <span style={css("position:absolute; inset:-8px; border-radius:50%; border:1px solid var(--weak-line); pointer-events:none; animation:rtFlash .6s ease-out 2 both")}></span>
                    </>) : null}
                    <span style={css("width:44px; height:44px; flex:none; display:block")}>
                      <svg viewBox="0 0 2000 2000" style={css("width:100%; height:100%; display:block")}>
                        <circle cx="1000" cy="1000" r="1000" fill="var(--asset-usdc)"></circle>
                        <path fill="#fff" d="M1275 1158c0-146-88-196-263-217-125-17-150-50-150-108s42-96 125-96c75 0 117 25 138 88 4 13 17 21 29 21h67c17 0 29-12 29-29v-4c-16-92-92-163-188-171v-100c0-17-12-29-33-33h-63c-17 0-29 12-33 33v96c-125 17-204 100-204 208 0 138 83 192 258 213 117 17 154 42 154 108s-58 112-137 112c-108 0-146-46-158-108-4-17-17-25-29-25h-71c-17 0-29 12-29 29v4c17 104 83 179 221 200v100c0 17 12 29 33 33h63c17 0 29-12 33-33v-100c125-21 208-108 208-225z"></path>
                        <path fill="#fff" d="M792 1596c-325-117-492-479-371-800 63-171 196-300 371-363 17-8 25-21 25-42v-58c0-17-8-29-25-33-4 0-13 0-17 4-396 125-613 546-488 942 75 233 254 412 488 488 17 8 33 0 37-17 4-4 4-8 4-17v-58c0-12-12-29-24-37zM1245 383c-17-8-33 0-37 17-4 4-4 8-4 17v58c0 17 12 33 25 42 325 117 492 479 371 800-63 171-196 300-371 362-17 8-25 21-25 42v58c0 17 8 29 25 33 4 0 13 0 17-4 396-125 613-546 488-942-75-238-258-417-489-483z"></path>
                      </svg></span>
                  </div>

                  
                  <div style={css("position:absolute; left:318px; top:144px; transform:translate(-50%,-50%); width:40px; height:40px; border-radius:50%; display:grid; place-items:center; box-shadow:var(--e-2); background:conic-gradient(from 214deg,var(--flag-ph-blue) 0 40%,var(--flag-ph-red) 40% 80%,#fff 80% 100%)")}>
                    {v.rtFlash2 ? (<>
                      <span style={css("position:absolute; inset:-8px; border-radius:50%; border:1px solid var(--weak-line); pointer-events:none; animation:rtFlash .6s ease-out 2 both")}></span>
                    </>) : null}
                    <span style={css("width:31px; height:31px; border-radius:50%; background:var(--n-0); display:grid; place-items:center; font-family:var(--mono); font-size:15px; font-weight:500; color:var(--n-900)")}>&#8369;</span>
                  </div>
                  <div style={css("position:absolute; left:318px; top:174px; transform:translateX(-50%); text-align:center; white-space:nowrap")}>
                    <div style={css("font-family:var(--mono); font-size:12px; font-weight:500; letter-spacing:.06em")}>PHP.T</div>
                    <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:10.5px; color:var(--muted)")}>&#8369;4,050.02</div>
                  </div>

                  <div style={css("position:absolute; left:50%; bottom:0; transform:translateX(-50%); font-family:var(--mono); font-size:10.5px; letter-spacing:.1em; color:var(--n-600); white-space:nowrap")}>ONE OPERATION &middot; ~5 S</div>
                </div>
              </div>
            </div>
  );
}
