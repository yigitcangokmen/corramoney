import React, { useEffect, useRef } from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';

const label = "font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)";
const panel = "padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); display:flex; flex-direction:column; gap:var(--sp-3)";
const note = "padding:var(--sp-4); background:var(--weak); border:1px solid var(--weak-line); border-radius:var(--r-sm)";
const mono = "font-family:var(--mono)";

function Busy({ v }: { v: Vals }) {
  return <div aria-live="polite">{busyBody(v)}</div>;
}

function busyBody(v: Vals) {
  if (v.busyText) {
    return (
      <div style={css("margin-top:var(--sp-4); display:flex; align-items:center; gap:var(--sp-3); " + note)}>
        <span style={css("flex:none; width:8px; height:8px; border-radius:50%; background:var(--brand); animation:dPulse 1.2s ease-in-out infinite")}></span>
        <span style={css("font-size:13.5px; color:var(--ink-brand)")}>{v.busyText}</span>
      </div>
    );
  }
  if (v.errorText) {
    return (
      <div role="alert" style={css("margin-top:var(--sp-4); padding:var(--sp-4); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-sm); font-size:13.5px; color:var(--amber)")}>
        {v.errorText}
      </div>
    );
  }
  return null;
}

function PopupLink({ v }: { v: Vals }) {
  if (!v.popupBlocked) return null;
  return (
    <div role="alert" style={css("margin-top:var(--sp-3); text-align:center; font-size:13.5px; color:var(--muted)")}>
      Your browser blocked the window. <a href={v.cashInUrl} target="_blank" rel="noopener">Open the deposit page</a></div>
  );
}

function Row({ k, val, strong }: { k: string; val: React.ReactNode; strong?: boolean }) {
  return (
    <div style={css("display:flex; justify-content:space-between; gap:var(--sp-3); font-size:14px")}>
      <span style={css("color:var(--muted)")}>{k}</span>
      <span style={css(mono + "; text-align:right; " + (strong ? "font-weight:500; color:var(--ink-brand)" : ""))}>{val}</span>
    </div>
  );
}

export default function Send({ v }: { v: Vals }) {
  const root = useRef<HTMLDivElement>(null);
  const step = v.remitForm ? 'form' : v.remitReview ? 'review' : v.remitCashin ? 'cashin' : 'track';
  const firstStep = useRef(true);
  // Each step replaces the card's content: move focus to its heading, but not on first load.
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    const h = root.current?.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
  }, [step]);
  return (
    <div ref={root} data-screen-label="Send" style={css("max-width:660px; margin:0 auto")}>
      <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-2); animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>

        {v.remitForm ? (
          <div>
            <h2 style={css("margin:0; font-size:24px; font-weight:600; letter-spacing:-.02em")}>Send money</h2>
            <p style={css("margin:var(--sp-2) 0 0; font-size:14px; color:var(--muted)")}>
              You fix what they receive. You sign each payment once, pay in pesos at the anchor, and can close the tab.</p>

            <div style={css("margin-top:var(--sp-6); " + label)}>Corridor</div>
            <div style={css("margin-top:var(--sp-3); display:grid; grid-template-columns:repeat(auto-fit, minmax(110px,1fr)); gap:var(--sp-2)")}>
              {(v.corridors || []).map((c: any) => (
                <button key={c.iso} onClick={c.pick} aria-pressed={c.pressed} style={css(c.style)}>
                  <span style={css(c.code)}>{c.iso}</span>
                  <span style={css("display:block; font-size:14px; font-weight:600; margin-top:var(--sp-2)")}>{c.name}</span>
                  <span style={css("display:block; " + mono + "; font-size:11px; color:var(--muted); margin-top:2px")}>MXN → {c.cur}</span>
                </button>
              ))}
            </div>

            <div style={css("margin-top:var(--sp-5); " + label)}>They receive</div>
            <label style={css("margin-top:var(--sp-2); display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); cursor:text")}>
              <span style={css(mono + "; font-size:24px; color:var(--muted)")}>{v.destSym}</span>
              <input type="text" inputMode="decimal" value={v.destText} onChange={v.onDest} aria-label="Amount the recipient receives"
                style={css("flex:1; min-width:0; background:transparent; border:none; " + mono + "; font-size:26px; font-weight:500; color:var(--text)")} />
              <span style={css(mono + "; font-size:13px; color:var(--muted)")}>{v.destCode}</span>
            </label>
            {v.amountHint ? <div style={css("margin-top:var(--sp-2); " + mono + "; font-size:11px; color:var(--amber)")}>{v.amountHint}</div> : null}

            <div style={css("margin-top:var(--sp-5); display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3)")}>
              <span style={css(label)}>Recipient account</span>
              {v.hasDemo ? (
                <button onClick={v.useDemo} style={css("background:none; border:none; padding:0; cursor:pointer; font-size:13px; font-weight:600; color:var(--ink-brand)")}>Use the demo recipient</button>
              ) : null}
            </div>
            <label style={css("margin-top:var(--sp-2); display:block; padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); cursor:text")}>
              <input type="text" value={v.addrText} onChange={v.onAddr} placeholder="G…" aria-label="Recipient Stellar account"
                style={css("width:100%; background:transparent; border:none; " + mono + "; font-size:13px; color:var(--text)")} />
            </label>
            <div aria-live="polite" style={css("margin-top:var(--sp-2); " + mono + "; font-size:11px; color:" + v.addrHintColor)}>{v.addrHint}</div>

            {v.isConnected
              ? <button onClick={v.getQuote} disabled={v.formNotReady} style={css(v.formBtnStyle)}>Get a quote</button>
              : <button onClick={v.doConnect} disabled={v.connecting} style={css(v.connectCtaStyle)}>{v.connectLabel}</button>}
            {v.formHint ? <div style={css("margin-top:var(--sp-2); text-align:center; " + mono + "; font-size:11px; color:var(--subtle)")}>{v.formHint}</div> : null}
            {v.freighterMissing ? (
              <div role="alert" style={css("margin-top:var(--sp-4); padding:var(--sp-4); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-sm); font-size:13.5px; color:var(--amber)")}>
                Freighter is not installed. <a href="https://www.freighter.app/" target="_blank" rel="noopener">Install Freighter</a>, then reload.</div>
            ) : null}
            <Busy v={v} />
          </div>
        ) : null}

        {v.remitReview ? (
          <div>
            <h2 style={css("margin:0; font-size:22px; font-weight:600; letter-spacing:-.02em")}>Review and sign</h2>

            <div style={css("margin-top:var(--sp-5); " + panel)}>
              <Row k="They receive (fixed)" val={v.receive} strong />
              <Row k="You pay at most (signed cap)" val={v.payUpTo} />
              <Row k="SPEI deposit at the anchor" val={v.depositDue} />
              <Row k="Current cost" val={v.payEst} />
              <Row k="Route" val={v.route} />
              <Row k="Slippage allowance" val={v.slippage} />
              <div style={css("height:1px; background:var(--line)")}></div>
              <Row k="Recipient" val={v.recipientShort} />
              <Row k="Quote" val={v.quoteId} />
              <Row k="Anchor SEP-38 quote" val={v.anchorQuote} />
            </div>

            <div style={css("margin-top:var(--sp-4); " + note)}>
              <div style={css("font-size:15px; font-weight:600; color:var(--ink-brand)")}>
                {v.promptsLeft === 1 ? 'One Freighter prompt' : v.promptsLeft + ' Freighter prompts'}</div>
              <ol style={css("margin:var(--sp-2) 0 0; padding-left:var(--sp-5); font-size:13.5px; color:var(--ink-brand); display:flex; flex-direction:column; gap:var(--sp-1)")}>
                <li style={css(v.loginDone ? "opacity:.55; text-decoration:line-through" : "")}>{v.loginLine}</li>
                <li style={css(v.setupDone ? "opacity:.55; text-decoration:line-through" : "")}>Set up your account. Corra sponsors the reserves, so you need no XLM.</li>
                <li>Sign the payment. Corra holds it, never your key, and submits it only after your cash-in lands. It dies on its own in 30 minutes.</li>
              </ol>
            </div>

            <div style={css("margin-top:var(--sp-5); display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:var(--sp-2)")}>
              <button onClick={v.back} disabled={v.signDisabled} style={css(v.ghostFlat)}>Back</button>
              <button onClick={v.signAndSend} disabled={v.signDisabled} style={css(v.ctaFlat)}>Sign and send</button>
            </div>
            <Busy v={v} />
          </div>
        ) : null}

        {v.remitCashin ? (
          <div>
            <h2 style={css("margin:0; font-size:22px; font-weight:600; letter-spacing:-.02em")}>Pay in pesos at the anchor</h2>
            <p style={css("margin:var(--sp-3) 0 0; font-size:14px; color:var(--muted)")}>
              Your payment <span style={css(mono)}>{v.paymentId}</span> is signed and held by Corra. Finish the SPEI deposit in
              the anchor's window. Once the anchor credits your account, Corra submits the payment you already signed.
              You can close this tab now.</p>
            <div style={css("margin-top:var(--sp-5); " + panel)}>
              <Row k="Deposit" val={v.depositSkipped ? 'none needed' : v.cashInDeposit} />
              <Row k="They receive" val={v.trackDest} strong />
            </div>
            {v.depositSkipped ? <div style={css("margin-top:var(--sp-4); font-size:13.5px; color:var(--ink-brand); " + note)}>{v.depositSkippedText}</div> : null}
            {v.cashInUrl ? <button onClick={v.reopenCashIn} style={css(v.ctaStyle)}>Open the anchor deposit window</button> : null}
            {v.canStartDeposit ? <button onClick={v.startDeposit} style={css(v.ctaStyle)}>Start the deposit</button> : null}
            <PopupLink v={v} />
            <Busy v={v} />
            <div style={css("margin-top:var(--sp-3); display:flex; align-items:center; gap:var(--sp-2); justify-content:center; " + mono + "; font-size:11px; color:var(--subtle)")}>
              <span style={css("width:6px; height:6px; border-radius:50%; background:var(--brand); animation:dPulse 1.4s ease-in-out infinite")}></span>
              Waiting for cash-in, confirmed from chain state</div>
          </div>
        ) : null}

        {v.remitTrack ? (
          <div>
            <div style={css("display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3); flex-wrap:wrap")}>
              <h2 style={css("margin:0; font-size:21px; font-weight:600; letter-spacing:-.02em")}>
                {v.credited ? 'Recipient credited' : v.failed ? v.failedTitle : 'Settling'}</h2>
              <span style={css(mono + "; font-size:12px; color:var(--muted)")}>{v.paymentId}</span>
            </div>
            <div style={css("margin-top:var(--sp-2); " + mono + "; font-size:13px; color:var(--muted)")}>
              {v.trackDest} to {v.trackRecipient}</div>

            <div style={css("margin-top:var(--sp-5); display:flex; flex-direction:column; gap:var(--sp-1)")}>
              {(v.sagaSteps || []).map((t: any, i: number) => (
                <div key={i} style={css(t.style)}>
                  <span style={css(t.dot)}>{t.mark}</span>
                  <div style={css("flex:1; min-width:0")}>
                    <div style={css("display:flex; justify-content:space-between; gap:var(--sp-3)")}>
                      <span style={css("font-size:14.5px; font-weight:600")}>{t.label}</span>
                      <span style={css(mono + "; font-size:11px; color:var(--subtle)")}>{t.at}</span>
                    </div>
                    <div style={css("font-size:12.5px; color:var(--muted); margin-top:2px")}>{t.detail}</div>
                    {t.link ? (
                      <a href={t.link} target="_blank" rel="noopener" style={css("display:inline-block; margin-top:var(--sp-1); " + mono + "; font-size:11px; color:var(--ink-brand)")}>
                        {t.linkText} on stellar.expert</a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>

            {v.canOpenDeposit ? <button onClick={v.reopenCashIn} style={css(v.ctaStyle)}>Open the anchor deposit window</button> : null}
            {v.canStartDeposit ? <button onClick={v.startDeposit} style={css(v.ctaStyle)}>Start the deposit</button> : null}
            <PopupLink v={v} />
            {v.trackError ? (
              <div role="alert" style={css("margin-top:var(--sp-5); padding:var(--sp-4); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-sm); font-size:13.5px; color:var(--amber)")}>
                {v.trackError}</div>
            ) : null}

            {v.failed ? (
              <div style={css("margin-top:var(--sp-5); padding:var(--sp-4); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-sm); font-size:13.5px; color:var(--amber)")}>
                {v.failedReason}
                {v.failedLink ? (
                  <a href={v.failedLink} target="_blank" rel="noopener" style={css("display:block; margin-top:var(--sp-2); " + mono + "; font-size:11px; color:var(--amber)")}>
                    The refused transaction on stellar.expert</a>
                ) : null}
              </div>
            ) : null}

            <div style={css("margin-top:var(--sp-5); display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:var(--sp-2)")}>
              {v.canResend ? <button onClick={v.resend} disabled={v.signDisabled} style={css(v.ctaFlat)}>Sign a new payment</button> : null}
              <button onClick={v.sendAnother} style={css(v.ghostFlat)}>Send another</button>
              <button onClick={v.goHistory} style={css(v.ghostFlat)}>History</button>
            </div>
            <Busy v={v} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
