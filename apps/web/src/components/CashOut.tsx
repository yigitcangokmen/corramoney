import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';
import { Row, mono, note, panel } from './Send';
import { BusyLine, ErrorLine } from './Balance';

const muted = "font-size:13.5px; color:var(--muted)";
const link = mono + "; font-size:11px; color:var(--ink-brand)";
const alert = "padding:var(--sp-4); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-sm); font-size:13.5px; color:var(--amber)";

function CashOutRow({ r, v }: { r: any; v: Vals }) {
  return (
    <div style={css(panel)}>
      <Row k={r.publicId} val={r.amountText} strong />
      <Row k="Received" val={r.dateText} />

      {r.state === 'ready' ? (
        r.other ? <div style={css(muted)}>Finish the cash-out in progress first.</div>
          : <button onClick={r.start} disabled={!r.canStart} style={css(r.startStyle + " margin-top:0")}>Cash out</button>
      ) : null}

      {r.state === 'short' ? (
        <div>
          <button disabled style={css(r.startStyle + " margin-top:0")}>Cash out</button>
          <div style={css("margin-top:var(--sp-2); " + muted)}>{r.shortText}</div>
        </div>
      ) : null}

      {r.state === 'anchor' ? (
        <div>
          <div style={css("font-size:13.5px; color:var(--ink-brand); " + note)}>Confirm the withdrawal on the anchor's page, then come back here.</div>
          {v.cashOutUrl ? (
            <div>
              <button onClick={r.open} style={css(v.ctaStyle)}>Open the anchor's page</button>
              {v.cashOutPopupBlocked ? (
                <div role="alert" style={css("margin-top:var(--sp-3); text-align:center; " + muted)}>
                  Your browser blocked the window. <a href={v.cashOutUrl} target="_blank" rel="noopener noreferrer">Open the anchor's page</a></div>
              ) : null}
            </div>
          ) : (
            <div style={css("margin-top:var(--sp-3); " + muted)}>
              The anchor's page for this withdrawal has expired. If you already confirmed it, the Sign button shows up here; otherwise start again.</div>
          )}
          <div style={css("margin-top:var(--sp-3); display:grid; grid-template-columns:1fr")}>
            <button onClick={r.reset} style={css(v.ghostFlat)}>Start again</button>
          </div>
        </div>
      ) : null}

      {r.state === 'sign' ? (
        <div>
          <div style={css("font-size:13.5px; color:var(--ink-brand); " + note)}>The anchor is ready. Sign the withdrawal: one Freighter prompt, Corra pays the fee.</div>
          <button onClick={r.sign} disabled={!r.signOk} style={css(r.signStyle)}>Sign the withdrawal</button>
          <div style={css("margin-top:var(--sp-3); display:grid; grid-template-columns:1fr")}>
            <button onClick={r.reset} disabled={!r.resetOk} style={css(v.ghostFlat)}>Start again</button>
          </div>
        </div>
      ) : null}

      {r.state === 'submitting' || r.state === 'onchain' ? (
        <div>
          <div style={css("display:flex; align-items:center; gap:var(--sp-2); " + muted)}>
            <span style={css("flex:none; width:6px; height:6px; border-radius:50%; background:var(--brand); animation:dPulse 1.4s ease-in-out infinite")}></span>
            <span>{r.state === 'submitting' ? 'Sending the withdrawal payment...'
              : r.paid ? 'Paid to the anchor' + (r.ledger ? ' in ledger ' + r.ledger : '') + '. Waiting for the anchor\'s confirmation.'
                : 'Sent; waiting for the network.'}</span>
          </div>
          {r.txLink ? <a href={r.txLink} target="_blank" rel="noopener noreferrer" style={css(link)}>On stellar.expert</a> : null}
          {r.state === 'onchain' && r.active ? (
            <div style={css("margin-top:var(--sp-3); display:grid; grid-template-columns:1fr")}>
              <button onClick={r.reset} style={css(v.ghostFlat)}>Back to the list</button>
            </div>
          ) : null}
        </div>
      ) : null}

      {r.state === 'done' ? (
        <div style={css("font-size:15px; font-weight:600; color:var(--ink-brand); " + note)}>
          Cashed out, anchor confirmed.
          <div style={css("margin-top:var(--sp-2); display:flex; gap:var(--sp-4); flex-wrap:wrap; font-weight:400")}>
            {r.txLink ? <a href={r.txLink} target="_blank" rel="noopener noreferrer" style={css(link)}>On stellar.expert</a> : null}
            {r.moreInfoUrl ? <a href={r.moreInfoUrl} target="_blank" rel="noopener noreferrer" style={css(link)}>Anchor record</a> : null}
          </div>
        </div>
      ) : null}

      {r.state === 'failed' ? (
        <div>
          <div style={css(alert)}>{r.reason}</div>
          {r.terminal ? null
            : r.other ? <div style={css("margin-top:var(--sp-2); " + muted)}>Finish the cash-out in progress first.</div>
            : <button onClick={r.start} disabled={!r.canStart} style={css(r.startStyle)}>Try again</button>}
        </div>
      ) : null}

      {r.state === 'unsupported' ? <div style={css(muted)}>{r.reason}</div> : null}
    </div>
  );
}

export default function CashOut({ v }: { v: Vals }) {
  return (
    <div data-screen-label="Cash out" style={css("max-width:660px; margin:0 auto")}>
      <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-2); animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>
        <h2 style={css("margin:0; font-size:24px; font-weight:600; letter-spacing:-.02em")}>Cash out</h2>
        <p style={css("margin:var(--sp-2) 0 0; font-size:14px; color:var(--muted)")}>
          Withdraw the TESTPHP sent to you at the anchor, to a simulated cash pickup. You sign one payment in Freighter; Corra pays the fee.</p>

        {v.cashOutNeedsSetup ? (
          <div>
            <div style={css("margin-top:var(--sp-5); font-size:13.5px; color:var(--ink-brand); " + note)}>
              Set up to cash out Philippine pesos (TESTPHP). Corra sponsors it, so you need no XLM.
              {v.cashOutSetupPrompt ? <div style={css("margin-top:var(--sp-1); " + mono + "; font-size:11px; color:var(--subtle)")}>One Freighter prompt</div> : null}
            </div>
            <button onClick={v.cashOutSetup} disabled={v.cashOutSetupDisabled} style={css(v.cashOutSetupStyle)}>Set up for cash-out</button>
          </div>
        ) : null}

        <div style={css("margin-top:var(--sp-5); font-size:14px; color:var(--muted)")}>
          TESTPHP in your account: <span style={css(mono + "; color:var(--text)")}>{v.cashOutBalanceText}</span></div>

        <BusyLine text={v.cashOutBusyText} />
        <ErrorLine text={v.cashOutErrorText} />

        {v.cashOutReading ? <div style={css("margin-top:var(--sp-4); " + muted)}>Reading your received payments...</div> : null}
        {v.cashOutReadError ? <div style={css("margin-top:var(--sp-4); " + muted)}>Could not reach Corra's server; trying again.</div> : null}
        {v.cashOutEmpty && !v.cashOutReadError ? (
          <div style={css("margin-top:var(--sp-4); " + muted)}>
            No payments to cash out. Payments sent to you in TESTPHP show here once they are credited to your account.</div>
        ) : null}

        <div style={css("margin-top:var(--sp-4); display:flex; flex-direction:column; gap:var(--sp-3)")}>
          {(v.cashOutRowsView || []).map((r: any) => <CashOutRow key={r.id} r={r} v={v} />)}
        </div>

        <div style={css("margin-top:var(--sp-5); " + mono + "; font-size:11px; color:var(--subtle)")}>
          Testnet. The payment to the anchor is a real Stellar transaction; the cash pickup is simulated and no cash moves.</div>
      </div>
    </div>
  );
}
