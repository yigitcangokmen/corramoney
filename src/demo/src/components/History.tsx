import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';

export default function History({ v }: { v: Vals }) {
  return (
      <div data-screen-label="History" style={css("max-width:820px; margin:0 auto; animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>
              <div style={css("display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3); flex-wrap:wrap")}>
                <h2 style={css("margin:0; font-size:24px; font-weight:600; letter-spacing:-.02em")}>Transaction history</h2>
                <span style={css("font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--subtle)")}>{v.historyCount}</span>
              </div>

              {v.historyEmpty ? (<>
                <div style={css("margin-top:var(--sp-6); padding:var(--sp-9) var(--sp-6); background:var(--surface); border:1px dashed var(--line-strong); border-radius:var(--r-lg); text-align:center")}>
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" style={css("display:inline-block")}>
                    <circle cx="12" cy="12" r="9" stroke="var(--n-400)" strokeWidth="1.8"></circle>
                    <path d="M12 7.5V12l3 2" stroke="var(--n-400)" strokeWidth="1.8" strokeLinecap="round"></path></svg>
                  <div style={css("margin-top:var(--sp-4); font-size:17px; font-weight:600")}>No transactions
                    yet</div>
                  <div style={css("margin-top:var(--sp-2); font-size:14px; color:var(--muted)")}>Your first
                    deposit will show up here.</div>
                  <button onClick={v.goDeposit} style={css(v.ctaFlat)}>Deposit TRY</button>
                </div>
              </>) : null}

              {v.hasHistory ? (<>
                <div style={css("margin-top:var(--sp-5); display:flex; flex-direction:column; gap:var(--sp-2)")}>
                  {(v.history || []).map((h: any, ih: number) => (<React.Fragment key={ih}>
                    <div style={css(h.style)}>
                      <div style={css("display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap")}>
                        <span style={css(h.dot)}></span>
                        <span style={css("font-size:15.5px; font-weight:600")}>{h.kind}</span>
                        <span style={css("margin-left:auto; font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; color:" + h.stateColor)}>{h.state}</span>
                      </div>
                      <div style={css("margin-top:var(--sp-3); display:grid; grid-template-columns:repeat(auto-fit, minmax(120px,1fr)); gap:var(--sp-3)")}>
                        <div><div style={css(v.kStyle)}>In</div>
                          <div style={css("font-family:var(--mono); font-size:14px; font-variant-numeric:tabular-nums")}>{h.inAmt}</div></div>
                        <div><div style={css(v.kStyle)}>Out</div>
                          <div style={css("font-family:var(--mono); font-size:14px; font-variant-numeric:tabular-nums")}>{h.outAmt}</div></div>
                        <div><div style={css(v.kStyle)}>Date</div>
                          <div style={css("font-family:var(--mono); font-size:14px")}>{h.when}</div></div>
                        {h.hasEarned ? (<>
                          <div><div style={css(v.kStyle)}>Earned</div>
                            <div style={css("font-family:var(--mono); font-size:14px; color:var(--ink-brand)")}>{h.earned}</div></div>
                        </>) : null}
                      </div>
                      {h.hasTx ? (<>
                        <a href="https://stellar.expert" target="_blank" rel="noopener" style={css("margin-top:var(--sp-3); display:inline-block; font-family:var(--mono); font-size:11.5px; letter-spacing:.06em")}>TX: {h.tx}</a>
                      </>) : null}
                    </div>
                  </React.Fragment>))}
                </div>
              </>) : null}

              <div style={css("margin-top:var(--sp-5); padding:var(--sp-4) var(--sp-5); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-md); font-size:13.5px; color:var(--amber)")}>
                Testnet demo. Settlement is real and independently verifiable; the bank transfer and
                cash steps are simulated.</div>
            </div>
  );
}
