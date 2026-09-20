import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function Nav({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Nav" style={css("position:sticky; top:0; z-index:50; background:rgba(255,255,255,.92); backdrop-filter:blur(12px); border-bottom:1px solid var(--line)")}>
        <div style={css("max-width:1200px; margin:0 auto; padding:0 var(--sp-6); height:68px; display:flex; align-items:center; gap:var(--sp-5); box-sizing:border-box")}>
          <div style={css("display:inline-flex; align-items:center; gap:0.34em; font-size:19px")}>
            <svg viewBox="0 0 100 100" fill="none" style={css("height:1.15em; width:auto; display:block")}>
              <path d="M82 24a36 36 0 100 52L62 60a14 14 0 110-20z" fill="var(--brand)"></path></svg>
            <span style={css("font-weight:600; letter-spacing:-.02em; line-height:1")}>Corra</span>
          </div>
          <div style={css("margin-left:auto; display:flex; align-items:center; gap:var(--sp-3)")}>
            <a href="mailto:hi@corra.money" style={css("display:inline-flex; align-items:center; font-size:14px; font-weight:600; padding:var(--sp-3) var(--sp-5); border-radius:var(--r-sm); background:var(--brand); color:var(--on)")}>Request access</a>
          </div>
        </div>
      </div>
  );
}
