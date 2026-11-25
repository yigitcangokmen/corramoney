import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';
import { Row, label, mono, note, panel } from './Send';
import PoolCard from './PoolCard';

const alert = "padding:var(--sp-4); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-sm); font-size:13.5px; color:var(--amber)";
const link = mono + "; font-size:11px; color:var(--ink-brand)";

export function BusyLine({ text }: { text: string | null }) {
  return (
    <div aria-live="polite">
      {text ? (
        <div style={css("margin-top:var(--sp-4); display:flex; align-items:center; gap:var(--sp-3); " + note)}>
          <span style={css("flex:none; width:8px; height:8px; border-radius:50%; background:var(--brand); animation:dPulse 1.2s ease-in-out infinite")}></span>
          <span style={css("font-size:13.5px; color:var(--ink-brand)")}>{text}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ErrorLine({ text }: { text: string | null }) {
  return text ? <div role="alert" style={css("margin-top:var(--sp-4); " + alert)}>{text}</div> : null;
}

function AddMoney({ v }: { v: Vals }) {
  return (
    <div>
      <div style={css("margin-top:var(--sp-6); " + label)}>Add money</div>

      {v.depositForm ? (
        <div>
          <label style={css("margin-top:var(--sp-3); display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); cursor:text")}>
            <span style={css(mono + "; font-size:24px; color:var(--muted)")}>MX$</span>
            <input type="text" inputMode="decimal" value={v.depositAmountText} onChange={v.onDepositAmount} aria-label="Amount to add, in MXN"
              placeholder="0.00" style={css("flex:1; min-width:0; background:transparent; border:none; " + mono + "; font-size:26px; font-weight:500; color:var(--text)")} />
            <span style={css(mono + "; font-size:13px; color:var(--muted)")}>MXN</span>
          </label>
          {v.depositAmountHint ? <div style={css("margin-top:var(--sp-2); " + mono + "; font-size:11px; color:var(--amber)")}>{v.depositAmountHint}</div> : null}
          <ErrorLine text={v.depositErrorText} />
          <button onClick={v.addMoney} disabled={!v.depositOk} style={css(v.depositBtnStyle)}>Add money</button>
          <div style={css("margin-top:var(--sp-2); text-align:center; " + mono + "; font-size:11px; color:var(--subtle)")}>
            You pay pesos by SPEI at the anchor (simulated on testnet) and receive the same amount of TESTMXN in your own account. Corra never holds it.</div>
        </div>
      ) : null}

      {v.depositStarting ? <BusyLine text={v.depositBusyText ?? 'Starting the deposit...'} /> : null}

      {v.depositWaiting ? (
        <div>
          {v.depositRows ? (
            <div style={css("margin-top:var(--sp-3); " + panel)}>
              <Row k="Deposit" val={v.depositRows.id} />
              <Row k="Amount" val={v.depositRows.amount} strong />
              <Row k="Anchor reference" val={v.depositRows.ref} />
            </div>
          ) : null}
          {v.depositUrl ? (
            <div>
              <button onClick={v.openAnchorPage} style={css(v.ctaStyle)}>Open the anchor's page</button>
              {v.depositPopupBlocked ? (
                <div role="alert" style={css("margin-top:var(--sp-3); text-align:center; font-size:13.5px; color:var(--muted)")}>
                  Your browser blocked the window. <a href={v.depositUrl} target="_blank" rel="noopener noreferrer">Open the anchor's page</a></div>
              ) : null}
              <div style={css("margin-top:var(--sp-2); text-align:center; " + mono + "; font-size:11px; color:var(--subtle)")}>
                The anchor's page works for 10 minutes. If it says the session is invalid, start over.</div>
            </div>
          ) : (
            <div style={css("margin-top:var(--sp-4); font-size:13.5px; color:var(--muted)")}>
              The anchor's page for this deposit has expired. If you already paid, it shows up here; otherwise start over.</div>
          )}
          <div style={css("margin-top:var(--sp-4); display:flex; align-items:center; gap:var(--sp-2); justify-content:center; " + mono + "; font-size:11px; color:var(--subtle)")}>
            <span style={css("width:6px; height:6px; border-radius:50%; background:var(--brand); animation:dPulse 1.4s ease-in-out infinite")}></span>
            Waiting for the anchor's payment, confirmed from chain state</div>
          {v.depositPartialText ? (
            <div style={css("margin-top:var(--sp-2); text-align:center; font-size:13.5px; color:var(--muted)")}>{v.depositPartialText}</div>
          ) : null}
          {v.depositSlow ? (
            <div style={css("margin-top:var(--sp-3); text-align:center; font-size:13.5px; color:var(--muted)")}>
              Still waiting. It will show up here and in History when the anchor pays; you can close this tab.</div>
          ) : null}
          <ErrorLine text={v.depositErrorText} />
          <div style={css("margin-top:var(--sp-4); display:grid; grid-template-columns:1fr")}>
            <button onClick={v.resetDeposit} style={css(v.ghostFlat)}>Start over</button>
          </div>
        </div>
      ) : null}

      {v.depositCredited ? (
        <div>
          <div style={css("margin-top:var(--sp-3); font-size:15px; font-weight:600; color:var(--ink-brand); " + note)}>
            {v.depositCreditedText}
            <div style={css("margin-top:var(--sp-2); display:flex; gap:var(--sp-4); flex-wrap:wrap; font-weight:400")}>
              {v.depositTxLink ? <a href={v.depositTxLink} target="_blank" rel="noopener noreferrer" style={css(link)}>On stellar.expert</a> : null}
              {v.depositAnchorLink ? <a href={v.depositAnchorLink} target="_blank" rel="noopener noreferrer" style={css(link)}>Anchor record</a> : null}
            </div>
          </div>
          <div style={css("margin-top:var(--sp-4); display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:var(--sp-2)")}>
            <button onClick={v.goSend} style={css(v.ctaFlat)}>Send money</button>
            <button onClick={v.resetDeposit} style={css(v.ghostFlat)}>Add more</button>
          </div>
        </div>
      ) : null}

      {v.depositExpired ? (
        <div>
          <div style={css("margin-top:var(--sp-3); " + alert)}>
            No payment arrived from the anchor within 24 hours. If it pays later, the deposit still shows up in History.</div>
          <div style={css("margin-top:var(--sp-4); display:grid; grid-template-columns:1fr")}>
            <button onClick={v.resetDeposit} style={css(v.ghostFlat)}>Start a new deposit</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Balance({ v }: { v: Vals }) {
  const st = v.balanceState;
  return (
    <div data-screen-label="Balance" style={css("max-width:660px; margin:0 auto")}>
      <div style={css("background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-2); animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>
        <h2 style={css("margin:0; font-size:24px; font-weight:600; letter-spacing:-.02em")}>Balance</h2>
        <p style={css("margin:var(--sp-2) 0 0; font-size:14px; color:var(--muted)")}>
          Your TESTMXN sits in your own Stellar account. Corra cannot move it; you approve every send in Freighter.</p>

        {st === 'disconnected' ? (
          <div style={css("margin-top:var(--sp-6); padding:var(--sp-7) var(--sp-5); border:1px dashed var(--line-strong); border-radius:var(--r-md); text-align:center")}>
            <div style={css("font-size:17px; font-weight:600")}>Connect Freighter to see your balance</div>
            <button onClick={v.doConnect} disabled={v.connecting} style={css(v.connectCtaStyle)}>{v.connectLabel}</button>
          </div>
        ) : null}

        {st === 'reading' ? <BusyLine text="Reading your account from Stellar..." /> : null}
        {st === 'reading' && v.balanceStale ? <div style={css("margin-top:var(--sp-2); font-size:12.5px; color:var(--muted)")}>Horizon is not answering; still trying.</div> : null}

        {st === 'setup' ? (
          <div>
            <div style={css("margin-top:var(--sp-5); font-size:13.5px; color:var(--ink-brand); " + note)}>
              {v.setupNote}</div>
            <button onClick={v.setupAccount} disabled={v.setupDisabled} style={css(v.setupBtnStyle)}>Set up your account</button>
            <BusyLine text={v.depositBusyText} />
            <ErrorLine text={v.depositErrorText} />
          </div>
        ) : null}

        {st === 'empty' || st === 'funded' ? (
          <div>
            <div style={css("margin-top:var(--sp-5); " + panel)}>
              <div style={css(label)}>TESTMXN</div>
              <div style={css("display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap")}>
                <span style={css(mono + "; font-size:30px; font-weight:500; font-variant-numeric:tabular-nums; overflow-wrap:anywhere")}>{v.balanceText}</span>
                <span style={css("font-size:13px; color:var(--muted)")}>TESTMXN</span>
              </div>
              {v.spendableRow ? <Row k="Spendable" val={v.spendableRow} /> : null}
              <Row k="Updated" val={v.balanceUpdated} />
              {v.balanceStale ? <div style={css("font-size:12.5px; color:var(--muted)")}>Horizon is not answering; showing the last known balance.</div> : null}
              {(v.otherBalanceRows || []).map((r: any) => <Row key={r.k} k={r.k} val={r.val} />)}
              <a href={v.accountLink} target="_blank" rel="noopener noreferrer" style={css(link)}>Your account on stellar.expert</a>
            </div>
            {st === 'empty' ? (
              <div style={css("margin-top:var(--sp-3); font-size:13.5px; color:var(--muted)")}>
                No money yet. Add money at the anchor; it stays in your own Stellar account.</div>
            ) : null}
            <AddMoney v={v} />
            <PoolCard v={v} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
