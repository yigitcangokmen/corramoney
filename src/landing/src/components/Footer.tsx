import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function Footer({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Footer" style={css("background:var(--n-950); padding:var(--sp-8) 0 var(--sp-6)")}>
        <div style={css("max-width:1200px; margin:0 auto; padding:0 var(--sp-6); box-sizing:border-box")}>

          <div style={css("display:flex; align-items:center; gap:var(--sp-4); margin-bottom:var(--sp-7)")}>
            <span style={css("flex:none; width:52px; height:52px; border-radius:50%; background:rgba(227,10,23,.14); border:1px solid rgba(227,10,23,.55); display:grid; place-items:center; font-family:var(--mono); font-size:20px; font-weight:500; color:#F26A72")}>&#8378;</span>
            <svg viewBox="0 0 400 8" style={css("flex:1; min-width:0; height:8px; display:block")}>
              <path d="M0 4 H400" stroke="rgba(255,255,255,.14)" strokeWidth="2"></path>
              <path d="M0 4 H400" stroke="var(--green-400)" strokeWidth="2" strokeDasharray="5 9" style={css("animation:ftRun 2.2s linear infinite")}></path></svg>
            <span style={css("flex:none; width:60px; height:60px; border-radius:50%; background:var(--green-400); display:grid; place-items:center; animation:ftBreathe 6s ease-in-out infinite")}>
              <svg viewBox="0 0 100 100" fill="none" style={css("width:44%; height:44%; display:block")}>
                <path d="M82 24a36 36 0 100 52L62 60a14 14 0 110-20z" fill="var(--n-950)"></path>
              </svg></span>
            <svg viewBox="0 0 400 8" style={css("flex:1; min-width:0; height:8px; display:block")}>
              <path d="M0 4 H400" stroke="rgba(255,255,255,.14)" strokeWidth="2"></path>
              <path d="M0 4 H400" stroke="var(--green-400)" strokeWidth="2" strokeDasharray="5 9" style={css("animation:ftRun 2.2s linear infinite")}></path></svg>
            <span style={css("flex:none; width:52px; height:52px; border-radius:50%; background:rgba(0,56,168,.2); border:1px solid rgba(76,124,222,.6); display:grid; place-items:center; font-family:var(--mono); font-size:20px; font-weight:500; color:#8FB2F0")}>&#8369;</span>
          </div>

          <div style={css("display:flex; justify-content:space-between; gap:var(--sp-6); flex-wrap:wrap")}>
            <div style={css("display:inline-flex; align-items:center; gap:0.34em; font-size:20px; color:var(--n-0)")}>
              <svg viewBox="0 0 100 100" fill="none" style={css("height:1.15em; width:auto; display:block")}>
                <path d="M82 24a36 36 0 100 52L62 60a14 14 0 110-20z" fill="var(--n-0)"></path></svg>
              <span style={css("font-weight:600; letter-spacing:-.02em; line-height:1")}>Corra</span>
            </div>
            <div style={css("display:flex; gap:var(--sp-6); flex-wrap:wrap; font-size:14px")}>
              <a href="#how" style={css("color:var(--n-25)")}>How it works</a>
              <a href="#corridors" style={css("color:var(--n-25)")}>Corridors</a>
              <a href="#" style={css("color:var(--n-25)")}>For anchors</a>
              <a href="#" style={css("color:var(--n-25)")}>Terms</a>
              <a href="https://github.com/yigitcangokmen/corramoney" target="_blank" rel="noopener" style={css("display:inline-flex; align-items:center; gap:7px; color:var(--n-25)")}>
                <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" style={css("flex:none; display:block")}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.15 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
                GitHub
              </a>
            </div>
          </div>

          <div style={css("margin-top:var(--sp-7); padding-top:var(--sp-5); border-top:1px solid rgba(255,255,255,.1)")}>
            <div style={css("display:flex; justify-content:space-between; gap:var(--sp-4); flex-wrap:wrap; font-family:var(--mono); font-size:12px; color:var(--n-400)")}>
              <span>&copy; 2026 Corra &middot; not a bank</span>
              <span>corra.money</span>
            </div>
          </div>
        </div>
      </div>
  );
}
