import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function Corridors({ v }: { v: Vals }) {
  return (
      <div id="corridors" data-screen-label="Corridors" style={css("padding:var(--sp-9) 0; background:var(--surface); border-top:1px solid var(--line)")}>
        <div style={css("max-width:1200px; margin:0 auto; padding:0 var(--sp-6); box-sizing:border-box")}>
          <div style={css("display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:var(--sp-7); gap:var(--sp-7); flex-wrap:wrap")}>
            <div>
              <div style={css("font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Corridors</div>
              <h2 style={css("margin:var(--sp-3) 0 0; font-size:clamp(30px,3.4vw,40px); font-weight:600; letter-spacing:-.025em; line-height:1.08; max-width:680px")}>
                From your wallet to <span style={css("color:var(--brand)")}>their hands</span>, in any
                direction.</h2>
            </div>
            <p style={css("margin:0; font-size:17px; color:var(--muted); max-width:360px")}>
              Every corridor is a work in progress. These are the four we are building, and how far
              along each one is.</p>
          </div>

          <div style={css("position:relative; margin-bottom:var(--sp-6); background:var(--bg); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6)")}>
            <svg viewBox="0 0 1180 200" width="100%" height="200">
              
              <path d="M 80 140 Q 340 34 552 56" stroke="var(--brand)" strokeWidth="2.5" fill="none" strokeDasharray="620" strokeDashoffset="620" style={css("animation:corDraw 1.6s cubic-bezier(.2,.8,.3,1) .3s forwards")}></path>
              <path d="M 628 56 Q 840 34 1100 140" stroke="var(--brand)" strokeWidth="2.5" fill="none" strokeDasharray="620" strokeDashoffset="620" style={css("animation:corDraw 1.6s cubic-bezier(.2,.8,.3,1) 1.5s forwards")}></path>
              <circle r="8" fill="var(--brand)" style={css("offset-path:path('M 80 140 Q 340 34 552 56'); animation:corTravel 3s cubic-bezier(.2,.8,.3,1) 1s infinite")}></circle>
              <circle r="8" fill="var(--brand)" style={css("offset-path:path('M 628 56 Q 840 34 1100 140'); animation:corTravel 3s cubic-bezier(.2,.8,.3,1) 2.5s infinite")}></circle>
              <circle cx="80" cy="140" r="13" fill="var(--n-900)"></circle>
              <text x="80" y="176" textAnchor="middle" fontSize="12" fill="var(--muted)" fontFamily="IBM Plex Mono" letterSpacing="1.4">MX</text>
              <circle cx="1100" cy="140" r="13" fill="var(--brand)"></circle>
              <text x="1100" y="176" textAnchor="middle" fontSize="12" fill="var(--muted)" fontFamily="IBM Plex Mono" letterSpacing="1.4">PH</text>
              
              <g style={css("transform-origin:590px 56px; animation:corJoin 6s ease-in-out infinite")}>
                <circle cx="590" cy="56" r="30" fill="var(--brand)"></circle>
                <path d="M82 24a36 36 0 100 52L62 60a14 14 0 110-20z" fill="var(--n-0)" transform="translate(575.04 41.5) scale(0.29)"></path>
              </g>
              <text x="590" y="112" textAnchor="middle" fontSize="11" fill="var(--ink-brand)" fontFamily="IBM Plex Mono" letterSpacing="1.6">CORRA</text>
            </svg>
          </div>

          <div style={css("display:grid; grid-template-columns:repeat(auto-fit, minmax(230px,1fr)); gap:var(--sp-4)")}>
            <div style={css("background:var(--surface); border:1px solid var(--weak-line); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-1)")}>
              <div style={css("font-family:var(--mono); font-size:24px; font-weight:500; font-variant-numeric:tabular-nums; letter-spacing:.04em; color:var(--text)")}>MX</div>
              <div style={css("margin-top:var(--sp-3); font-weight:600; font-size:19px")}>Mexico</div>
              <div style={css("font-size:13.5px; color:var(--muted); margin-top:var(--sp-1)")}>MXN &middot;
                anchor outreach</div>
              <div style={css(v.corTrack)}><div style={css(v.corFill35)}></div></div>
              <div style={css(v.corNote)}>In progress &middot; anchor talks</div>
            </div>
            <div style={css("background:var(--surface); border:1px solid var(--weak-line); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-1)")}>
              <div style={css("font-family:var(--mono); font-size:24px; font-weight:500; font-variant-numeric:tabular-nums; letter-spacing:.04em; color:var(--text)")}>PH</div>
              <div style={css("margin-top:var(--sp-3); font-weight:600; font-size:19px")}>Philippines</div>
              <div style={css("font-size:13.5px; color:var(--muted); margin-top:var(--sp-1)")}>PHP &middot;
                anchor outreach</div>
              <div style={css(v.corTrack)}><div style={css(v.corFill35)}></div></div>
              <div style={css(v.corNote)}>In progress &middot; anchor talks</div>
            </div>
            <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-1)")}>
              <div style={css("font-family:var(--mono); font-size:24px; font-weight:500; font-variant-numeric:tabular-nums; letter-spacing:.04em; color:var(--muted)")}>TR</div>
              <div style={css("margin-top:var(--sp-3); font-weight:600; font-size:19px")}>Türkiye</div>
              <div style={css("font-size:13.5px; color:var(--muted); margin-top:var(--sp-1)")}>TRY &middot;
                anchor outreach</div>
              <div style={css(v.corTrack)}><div style={css(v.corFill25)}></div></div>
              <div style={css(v.corNote)}>In progress &middot; anchor talks</div>
            </div>
            <div style={css("background:var(--n-900); color:var(--n-0); border-radius:var(--r-md); padding:var(--sp-5)")}>
              <div style={css("font-family:var(--mono); font-size:24px; font-weight:500; font-variant-numeric:tabular-nums; letter-spacing:.04em; color:var(--green-300)")}>ID &middot; TH</div>
              <div style={css("margin-top:var(--sp-3); font-weight:600; font-size:19px")}>Next</div>
              <div style={css("font-size:13.5px; color:var(--n-300); margin-top:var(--sp-1)")}>IDR, THB
                &middot; anchor selection</div>
              <div style={css(v.corTrackDark)}><div style={css(v.corFill15)}></div></div>
              <div style={css(v.corNoteDark)}>In progress &middot; scoping</div>
            </div>
          </div>

          <div style={css("margin-top:var(--sp-4); padding:var(--sp-4) var(--sp-5); background:var(--bg); border:1px dashed var(--line-strong); border-radius:var(--r-md); display:flex; align-items:center; gap:var(--sp-5); flex-wrap:wrap")}>
            <span style={css("font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>On the map</span>
            <span style={css("font-family:var(--mono); font-size:13.5px; color:var(--muted); letter-spacing:.06em")}>BRL &middot; INR &middot; NGN &middot; KES</span>
          </div>
        </div>
      </div>
  );
}
