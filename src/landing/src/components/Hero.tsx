import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/state';

export default function Hero({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Hero" style={css("position:relative; background:var(--surface); border-bottom:1px solid var(--line); overflow:hidden; padding:var(--sp-9) 0 var(--sp-8)")}>
        <div style={css("max-width:1200px; margin:0 auto; padding:0 var(--sp-6); box-sizing:border-box; display:grid; grid-template-columns:repeat(auto-fit, minmax(300px,1fr)); gap:var(--sp-7); align-items:center")}>

          <div style={css("order:2; position:relative; justify-self:center; width:100%; max-width:460px; aspect-ratio:1; pointer-events:none")}>
            <div style={css("position:absolute; inset:0; background:repeating-radial-gradient(circle at 50% 50%, rgba(14,133,70,.26) 0 1.5px, transparent 1.5px 34px); mask-image:radial-gradient(circle at 50% 50%, #000 16%, transparent 72%); -webkit-mask-image:radial-gradient(circle at 50% 50%, #000 16%, transparent 72%)")}></div>

            <div style={css("position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:0; height:0; z-index:2")}>
              <span style={css("position:absolute; left:-200px; top:-200px; width:400px; height:400px; border-radius:50%; border:1px solid var(--weak-line); animation:lmEmit 6s cubic-bezier(.2,.7,.4,1) infinite")}></span>
              <span style={css("position:absolute; left:-200px; top:-200px; width:400px; height:400px; border-radius:50%; border:1px solid var(--weak-line); animation:lmEmit 6s cubic-bezier(.2,.7,.4,1) 2s infinite")}></span>
              <span style={css("position:absolute; left:-200px; top:-200px; width:400px; height:400px; border-radius:50%; border:1px solid var(--weak-line); animation:lmEmit 6s cubic-bezier(.2,.7,.4,1) 4s infinite")}></span>

              <span style={css("--a:225deg; position:absolute; left:0; top:0; animation:lmSeq1 10.2s linear infinite")}>
                <span style={css(v.pkt + " transform:translate(-50%,-50%) rotate(-225deg)")}>&#8378; TRY</span></span>
              <span style={css("--a:45deg; position:absolute; left:0; top:0; animation:lmSeq2 10.2s linear infinite")}>
                <span style={css(v.pkt + " transform:translate(-50%,-50%) rotate(-45deg)")}>MX$</span></span>
              <span style={css("--a:315deg; position:absolute; left:0; top:0; animation:lmSeq3 10.2s linear infinite")}>
                <span style={css(v.pkt + " transform:translate(-50%,-50%) rotate(-315deg)")}>&#8364; EUR</span></span>
              <span style={css("--a:135deg; position:absolute; left:0; top:0; animation:lmSeq4 10.2s linear infinite")}>
                <span style={css(v.pkt + " transform:translate(-50%,-50%) rotate(-135deg)")}>&#8369; PHP</span></span>
            </div>

            <div style={css("position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:132px; height:132px")}>
              <div style={css("width:100%; height:100%; border-radius:50%; background:var(--brand); display:grid; place-items:center; box-shadow:var(--e-3); animation:lmBreathe 8s ease-in-out infinite")}>
                <svg viewBox="0 0 100 100" fill="none" style={css("width:54px; height:54px; display:block")}>
                  <path d="M82 24a36 36 0 100 52L62 60a14 14 0 110-20z" fill="var(--n-0)"></path>
                </svg></div>
            </div>
          </div>

          <div style={css("order:1; min-width:0")}>
          <h1 style={css("margin:0; font-size:clamp(34px,4.4vw,64px); font-weight:600; letter-spacing:-.045em; line-height:1.02")}>Local money in.<br />Local money out.</h1>

          <div style={css("margin-top:var(--sp-7); font-family:var(--mono); font-size:11.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-brand)")}>For any pair, in 3 steps</div>

          <div style={css("margin-top:var(--sp-5); display:flex; flex-direction:column; gap:var(--sp-4)")}>
            <div style={css("display:flex; gap:var(--sp-4); align-items:baseline")}>
              <span style={css("flex:none; width:26px; font-family:var(--mono); font-size:11px; letter-spacing:.12em; color:var(--muted)")}>01</span>
              <span style={css("font-size:16px")}>Cash partners take the money in and pay it out</span></div>
            <div style={css("display:flex; gap:var(--sp-4); align-items:baseline")}>
              <span style={css("flex:none; width:26px; font-family:var(--mono); font-size:11px; letter-spacing:.12em; color:var(--muted)")}>02</span>
              <span style={css("font-size:16px")}>Anchors turn local currency into a transferable
                balance</span></div>
            <div style={css("display:flex; gap:var(--sp-4); align-items:baseline")}>
              <span style={css("flex:none; width:26px; font-family:var(--mono); font-size:11px; letter-spacing:.12em; color:var(--ink-brand)")}>03</span>
              <span style={css("font-size:16px; font-weight:600")}>Corra prices, routes and settles
                it</span></div>
          </div>
          </div>

        </div>
      </div>
  );
}
