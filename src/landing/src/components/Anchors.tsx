import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function Anchors({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Anchors" style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); box-shadow:var(--e-1); overflow:hidden; display:grid; grid-template-columns:repeat(auto-fit, minmax(300px,1fr))")}>

              <div style={css("order:1; background:var(--sunken); border-right:1px solid var(--line); min-height:352px; display:flex; align-items:center; justify-content:center; padding:var(--sp-6)")}>
                <div style={css("width:100%; max-width:348px; display:flex; flex-direction:column; gap:var(--sp-4)")}>

                  <div style={css("background:var(--surface); border:1px dashed var(--line-strong); border-radius:var(--r-md); padding:var(--sp-5)")}>
                    <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--n-600)")}>Before</div>
                    <div style={css("margin-top:var(--sp-4); display:flex; gap:var(--sp-2)")}>
                      <span style={css("display:grid; place-items:center; width:54px; height:54px; border-radius:var(--r-sm); border:1.5px solid var(--line-strong); font-family:var(--mono); font-size:12px; font-weight:500; color:var(--n-700)")}>MXN</span>
                      <span style={css("display:grid; place-items:center; width:54px; height:54px; border-radius:var(--r-sm); border:1.5px dashed var(--line-strong); font-family:var(--mono); font-size:16px; color:var(--n-500)")}>+</span>
                      <span style={css("display:grid; place-items:center; width:54px; height:54px; border-radius:var(--r-sm); border:1.5px dashed var(--line-strong); font-family:var(--mono); font-size:16px; color:var(--n-500)")}>+</span></div>
                  </div>

                  <div style={css("display:flex; justify-content:center")}>
                    <span style={css("display:grid; place-items:center; width:54px; height:54px; border-radius:50%; background:var(--brand); box-shadow:var(--e-2); animation:lmBreathe 8s ease-in-out infinite")}>
                      <svg viewBox="0 0 100 100" fill="none" style={css("width:44%; height:44%; display:block")}>
                        <path d="M82 24a36 36 0 100 52L62 60a14 14 0 110-20z" fill="var(--n-0)"></path></svg></span>
                  </div>

                  <div style={css("background:var(--surface); border:1px solid var(--weak-line); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-2)")}>
                    <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-brand)")}>After</div>
                    <div style={css("margin-top:var(--sp-4); display:flex; gap:var(--sp-2)")}>
                      <span style={css("display:grid; place-items:center; width:54px; height:54px; border-radius:var(--r-sm); background:var(--brand); color:var(--on); font-family:var(--mono); font-size:12px; font-weight:500")}>MXN</span>
                      <span style={css("display:grid; place-items:center; width:54px; height:54px; border-radius:var(--r-sm); background:var(--brand); color:var(--on); font-family:var(--mono); font-size:12px; font-weight:500")}>PHP</span>
                      <span style={css("display:grid; place-items:center; width:54px; height:54px; border-radius:var(--r-sm); background:var(--brand); color:var(--on); font-family:var(--mono); font-size:12px; font-weight:500")}>TRY</span></div>
                  </div>
                </div>
              </div>

              <div style={css("order:2; padding:var(--sp-7); display:flex; flex-direction:column; justify-content:center")}>
                <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--n-600)")}>06</div>
                <h3 style={css("margin:var(--sp-3) 0 0; font-size:32px; font-weight:600; letter-spacing:-.02em; line-height:1.14")}>Anchors</h3>
                <p style={css("margin:var(--sp-4) 0 0; font-size:17px; color:var(--muted); max-width:380px")}>
                  An anchor arrives with the one market its licence covers. One adapter later it can
                  serve every corridor on the rail, and the ones we add after that cost it nothing.</p>
                <a href="Corra For Anchors.dc.html" style={css("margin-top:var(--sp-6); display:inline-flex; align-items:center; gap:var(--sp-2); font-size:15px; font-weight:600; color:var(--ink-brand)")}>
                  Corra for anchors
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"></path></svg></a>
              </div>
            </div>
  );
}
