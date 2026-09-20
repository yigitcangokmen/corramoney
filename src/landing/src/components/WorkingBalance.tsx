import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function WorkingBalance({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Working balance" style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); box-shadow:var(--e-1); overflow:hidden; display:grid; grid-template-columns:repeat(auto-fit, minmax(300px,1fr))")}>

              <div style={css("order:2; background:var(--sunken); border-left:1px solid var(--line); min-height:352px; display:flex; align-items:center; justify-content:center; padding:var(--sp-6)")}>
                <div style={css("width:100%; max-width:348px; display:flex; flex-direction:column; gap:var(--sp-4)")}>

                  
                  <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-md); padding:var(--sp-5); color:var(--n-500)")}>
                    <div style={css("display:flex; justify-content:space-between; align-items:baseline; gap:var(--sp-4)")}>
                      <span style={css("font-size:16px")}>Bank account</span>
                      <span style={css("font-family:var(--mono); font-size:20px")}>&#8378;3,500.00</span></div>
                    <div style={css("margin-top:var(--sp-2); font-size:14px")}>unchanged since Monday</div>
                  </div>

                  
                  <div style={css("background:var(--surface); border:1px solid var(--weak-line); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-2)")}>
                    <div style={css("display:flex; justify-content:space-between; align-items:baseline; gap:var(--sp-4)")}>
                      <span style={css("font-size:16px; font-weight:600")}>Corra balance</span>
                      <span style={css("display:inline-flex; align-items:baseline; font-family:var(--mono); font-size:20px; font-weight:500; font-variant-numeric:tabular-nums")}>
                        <span>&#8378;3,501.</span>
                        {(v.ybDigits || []).map((d: any, id: number) => (<React.Fragment key={id}>
                          <span style={css(d.style)}>{d.v}</span>
                        </React.Fragment>))}</span>
                    </div>
                    <div style={css("margin-top:var(--sp-2); display:flex; align-items:center; gap:var(--sp-3); font-size:14px; color:var(--ink-brand)")}>
                      <span style={css(v.ybDotStyle)}></span>{v.ybEarned} more than Monday</div>
                  </div>

                  <div style={css("font-family:var(--mono); font-size:11px; letter-spacing:.06em; color:var(--n-600); line-height:1.7")}>
                    BLEND &middot; USDC POOL &middot; NOT A DEPOSIT &middot; RATE MOVES</div>
                </div>
              </div>

              <div style={css("order:1; padding:var(--sp-7); display:flex; flex-direction:column; justify-content:center")}>
                <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--n-600)")}>05</div>
                <h3 style={css("margin:var(--sp-3) 0 0; font-size:32px; font-weight:600; letter-spacing:-.02em; line-height:1.14")}>Working balance</h3>
                <p style={css("margin:var(--sp-4) 0 0; font-size:17px; color:var(--muted); max-width:380px")}>
                  Money waiting to be sent does not have to sit dead. Until you send it, your balance
                  earns, and you can pull it back the moment you need it. One tap in, one tap out.</p>
                <a href="#" style={css("margin-top:var(--sp-6); display:inline-flex; align-items:center; gap:var(--sp-2); font-size:15px; font-weight:600; color:var(--ink-brand)")}>
                  How the rate works
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"></path></svg></a>
              </div>
            </div>
  );
}
