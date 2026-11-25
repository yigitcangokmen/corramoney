import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';
import { Row, label, mono, note, panel } from './Send';
import { BusyLine, ErrorLine } from './Balance';

const link = mono + "; font-size:11px; color:var(--ink-brand)";
const chipCss = mono + "; font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-xs); padding:2px var(--sp-2)";

/** The user's position in the Blend lending pool, and the form to move TESTMXN in or out. */
export default function PoolCard({ v }: { v: Vals }) {
  if (!v.poolShown) return null;
  const st = v.poolState;
  return (
    <div>
      <div style={css("margin-top:var(--sp-6); display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap")}>
        <span style={css(label)}>Lending pool (Blend)</span>
        {v.poolStatusText ? <span style={css(chipCss)}>{v.poolStatusText}</span> : null}
      </div>

      {st === 'unavailable' ? (
        <div style={css("margin-top:var(--sp-3); font-size:13.5px; color:var(--muted)")}>The pool is not deployed on this testnet yet.</div>
      ) : null}

      {st === 'reading' ? <BusyLine text="Reading the pool..." /> : null}
      {st === 'error' ? <ErrorLine text={'The pool is not answering. ' + (v.poolReadErrorText ?? '')} /> : null}

      {st === 'ready' ? (
        <div>
          <div style={css("margin-top:var(--sp-3); " + panel)}>
            {v.poolEmpty ? (
              <div style={css("font-size:15px; font-weight:600")}>Nothing in the pool.</div>
            ) : (
              <div style={css("display:flex; align-items:baseline; gap:var(--sp-2); flex-wrap:wrap")}>
                <span style={css(mono + "; font-size:26px; font-weight:500; font-variant-numeric:tabular-nums; overflow-wrap:anywhere")}>{v.poolPositionText}</span>
                <span style={css("font-size:13px; color:var(--muted)")}>{v.poolAssetCode} in the pool</span>
              </div>
            )}
            <Row k="Rate" val={v.poolRateText} />
            <Row k="Pool admin" val={v.poolAdminText} />
            {v.poolStale ? <div style={css("font-size:12.5px; color:var(--muted)")}>The pool is not answering; showing the last known position.</div> : null}
            <a href={v.poolLink} target="_blank" rel="noopener noreferrer" style={css(link)}>The pool on stellar.expert</a>
          </div>
          <div style={css("margin-top:var(--sp-3); font-size:13px; color:var(--muted)")}>{v.poolNote}</div>

          {v.poolDoneStep ? (
            <div>
              <div style={css("margin-top:var(--sp-4); font-size:15px; font-weight:600; color:var(--ink-brand); " + note)}>
                {v.poolDoneText}
                {v.poolDoneLink ? (
                  <div style={css("margin-top:var(--sp-2); font-weight:400")}>
                    <a href={v.poolDoneLink} target="_blank" rel="noopener noreferrer" style={css(link)}>On stellar.expert</a>
                  </div>
                ) : null}
              </div>
              <div style={css("margin-top:var(--sp-4); display:grid; grid-template-columns:1fr")}>
                <button onClick={v.resetPool} style={css(v.ghostFlat)}>Again</button>
              </div>
            </div>
          ) : (
            <div>
              <label style={css("margin-top:var(--sp-4); display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); cursor:text")}>
                <input type="text" inputMode="decimal" value={v.poolAmountText} onChange={v.onPoolAmount} aria-label={'Amount of ' + v.poolAssetCode}
                  placeholder="0.00" disabled={v.poolWorking} style={css("flex:1; min-width:0; background:transparent; border:none; " + mono + "; font-size:22px; font-weight:500; color:var(--text)")} />
                <span style={css(mono + "; font-size:13px; color:var(--muted)")}>{v.poolAssetCode}</span>
              </label>
              <div style={css("margin-top:var(--sp-2); display:flex; justify-content:space-between; gap:var(--sp-3); flex-wrap:wrap; " + mono + "; font-size:11px; color:var(--subtle)")}>
                <span>{v.poolAmountHint}</span>
                <button onClick={v.poolAll} disabled={!v.poolAllOk}
                  style={css("border:none; background:none; padding:0; " + mono + "; font-size:11px; text-decoration:underline; " + (v.poolAllOk ? 'color:var(--ink-brand); cursor:pointer' : 'color:var(--subtle); cursor:not-allowed'))}>
                  all (take back everything)</button>
              </div>
              {v.poolBlocked ? (
                <div style={css("margin-top:var(--sp-3); font-size:13.5px; color:var(--muted)")}>Wait until your payment from the balance lands.</div>
              ) : null}
              {v.poolWorking ? <BusyLine text={v.poolBusyText} /> : null}
              <ErrorLine text={v.poolErrorText} />
              <div style={css("margin-top:var(--sp-4); display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:var(--sp-2)")}>
                <button onClick={v.poolSupply} disabled={!v.poolSupplyOk} style={css(v.poolSupplyStyle)}>Move to pool</button>
                <button onClick={v.poolWithdraw} disabled={!v.poolWithdrawOk} style={css(v.poolWithdrawStyle)}>Take back</button>
              </div>
              <div style={css("margin-top:var(--sp-2); text-align:center; " + mono + "; font-size:11px; color:var(--subtle)")}>
                One Freighter prompt per move; Corra pays the network fee. The TESTMXN stays yours in the pool contract.</div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
