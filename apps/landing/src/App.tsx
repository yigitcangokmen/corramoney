import React from 'react';
import { useClock } from './hooks/useClock';
import { deriveVals } from './logic/state';
import { css } from './logic/styles';
import Nav from './components/Nav';
import Hero from './components/Hero';
import CashIn from './components/CashIn';
import Payout from './components/Payout';
import Routing from './components/Routing';
import Proof from './components/Proof';
import WorkingBalance from './components/WorkingBalance';
import Anchors from './components/Anchors';
import Corridors from './components/Corridors';
import Footer from './components/Footer';

export default function App() {
  const e = useClock();
  const v = deriveVals(e);

  return (
    <div style={{ background: 'var(--surface)' }}>
      <Nav v={v} />
      <Hero v={v} />
      <div style={css("background:var(--bg); padding:var(--sp-9) 0")}>
      <div style={css("max-width:1200px; margin:0 auto; padding:0 var(--sp-6); box-sizing:border-box")}>
      
      <div style={css("max-width:620px")}>
      <div style={css("font-family:var(--mono); font-size:12px; letter-spacing:.16em; text-transform:uppercase; color:var(--subtle)")}>What Corra does</div>
      <h2 style={css("margin:var(--sp-3) 0 0; font-size:clamp(30px,3.4vw,40px); font-weight:600; letter-spacing:-.025em; line-height:1.12")}>The moving parts, one transfer.</h2>
      <p style={css("margin:var(--sp-4) 0 0; font-size:17px; color:var(--muted)")}>
      Money enters in one currency and leaves in another. These are the pieces that
      hold it together.</p>
      </div>
      
      <div style={css("margin-top:var(--sp-7); display:flex; flex-direction:column; gap:var(--sp-4)")}>
      <CashIn v={v} />
      <Payout v={v} />
      <Routing v={v} />
      <Proof v={v} />
      <WorkingBalance v={v} />
      <Anchors v={v} />
      </div>
      </div>
      </div>
      <Corridors v={v} />
      <Footer v={v} />
    </div>
  );
}
