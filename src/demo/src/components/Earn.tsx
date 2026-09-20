import React from 'react';
import { css } from '../logic/styles';
import type { Vals } from '../logic/vals';

export default function Earn({ v }: { v: Vals }) {
  return (
      <div data-screen-label="Earn" style={css("max-width:820px; margin:0 auto; animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>

              <div style={css("display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:var(--sp-3)")}>
                <div style={css("padding:var(--sp-5); background:var(--surface); border:1px solid var(--line); border-radius:var(--r-md); box-shadow:var(--e-1)")}>
                  <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>In the vault</div>
                  <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:26px; font-weight:500; font-variant-numeric:tabular-nums")}>{v.vaultLabel}</div></div>
                <div style={css("padding:var(--sp-5); background:var(--surface); border:1px solid var(--weak-line); border-radius:var(--r-md); box-shadow:var(--e-1)")}>
                  <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-brand)")}>Earned</div>
                  <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:26px; font-weight:500; color:var(--ink-brand); font-variant-numeric:tabular-nums")}>{v.earnedBig}<span style={css("font-size:17px; color:var(--green-500)")}>{v.earnedTail}</span></div></div>
                <div style={css("padding:var(--sp-5); background:var(--surface); border:1px solid var(--line); border-radius:var(--r-md); box-shadow:var(--e-1)")}>
                  <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>In your wallet</div>
                  <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:26px; font-weight:500; font-variant-numeric:tabular-nums")}>{v.walletLabel}</div></div>
              </div>

              <div style={css("margin-top:var(--sp-4); background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-2)")}>
                <h2 style={css("margin:0; font-size:20px; font-weight:600; letter-spacing:-.02em")}>Put your waiting balance to work</h2>
                <p style={css("margin:var(--sp-2) 0 0; font-size:14.5px; color:var(--muted)")}>
                  While it waits to be sent, your balance earns. Pull it back whenever you want.</p>

                <div style={css("margin-top:var(--sp-5); display:flex; gap:var(--sp-2); flex-wrap:wrap")}>
                  <label style={css("flex:1; min-width:200px; display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-4); background:var(--sunken); border:1px solid var(--line); border-radius:var(--r-sm); cursor:text")}>
                    <input type="text" inputMode="decimal" value={v.vaultText} onChange={v.onVault} placeholder="Amount" style={css("flex:1; min-width:0; background:transparent; border:none; outline:none; font-family:var(--mono); font-size:19px; font-weight:500; color:var(--text)")} />
                    <span style={css("font-family:var(--mono); font-size:12.5px; color:var(--muted)")}>USDC</span>
                  </label>
                  <button onClick={v.vaultGo} disabled={v.vaultNotReady} style={css(v.vaultBtnStyle)}>Deposit</button>
                </div>

                <div style={css("margin-top:var(--sp-5); font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Choose a vault</div>
                <div style={css("margin-top:var(--sp-3); display:grid; grid-template-columns:repeat(auto-fit, minmax(210px,1fr)); gap:var(--sp-2)")}>
                  {(v.vaults || []).map((v: any, iv: number) => (<React.Fragment key={iv}>
                    <button onClick={v.pick} style={css(v.style)}>
                      <div style={css("display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3)")}>
                        <span style={css("font-size:15.5px; font-weight:600")}>{v.name}</span>
                        <span style={css("font-family:var(--mono); font-size:15px; font-weight:500; color:var(--ink-brand)")}>{v.apy}</span></div>
                      <div style={css("margin-top:var(--sp-1); font-size:13px; color:var(--muted); text-align:left")}>{v.note}</div>
                      <div style={css("margin-top:var(--sp-3); font-family:var(--mono); font-size:11px; color:var(--subtle); text-align:left")}>{v.addr}</div>
                    </button>
                  </React.Fragment>))}
                </div>
                <div style={css("margin-top:var(--sp-3); font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; color:var(--subtle)")}>NOT A DEPOSIT &middot; RATE MOVES &middot; YOU SIGN EVERY MOVE</div>
              </div>

              {v.hasPosition ? (<>
                <div style={css("margin-top:var(--sp-4); background:var(--surface); border:1px solid var(--weak-line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-2)")}>
                  <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Active positions</div>

                  <div style={css("margin-top:var(--sp-4); text-align:center; padding:var(--sp-5); background:var(--sunken); border-radius:var(--r-sm)")}>
                    <div style={css("font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted)")}>Earning live</div>
                    <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:34px; font-weight:500; color:var(--ink-brand); letter-spacing:-.02em; font-variant-numeric:tabular-nums")}>{v.tickerBig}<span style={css("color:var(--green-600)")}>{v.tickerTail}</span></div>
                    <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:11.5px; color:var(--muted)")}>{v.vaultLabel} across {v.posCount}</div>
                  </div>

                  <div style={css("margin-top:var(--sp-3); display:flex; flex-direction:column; gap:var(--sp-2)")}>
                    {(v.positions || []).map((p: any, ip: number) => (<React.Fragment key={ip}>
                      <div style={css("display:flex; align-items:center; gap:var(--sp-4); padding:var(--sp-4); border:1px solid var(--line); border-radius:var(--r-sm); flex-wrap:wrap")}>
                        <div style={css("min-width:0")}>
                          <div style={css("display:flex; align-items:baseline; gap:var(--sp-3); flex-wrap:wrap")}>
                            <span style={css("font-size:15px; font-weight:600")}>{p.name}</span>
                            <span style={css("font-family:var(--mono); font-size:11px; color:var(--ink-brand)")}>{p.apy}</span></div>
                          <div style={css("margin-top:var(--sp-1); font-family:var(--mono); font-size:15px; font-weight:500; font-variant-numeric:tabular-nums")}>{p.amt}</div>
                          <div style={css("font-family:var(--mono); font-size:11px; color:var(--subtle)")}>{p.age} &middot; on-chain</div></div>
                        <div style={css("margin-left:auto; text-align:right")}>
                          <div style={css("font-family:var(--mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--subtle)")}>Earned</div>
                          <div style={css("font-family:var(--mono); font-size:15px; font-weight:500; color:var(--ink-brand); font-variant-numeric:tabular-nums")}>{p.earnBig}<span style={css("font-size:11px; color:var(--green-500)")}>{p.earnTail}</span></div></div>
                        <button onClick={p.out} style={css("font-size:13.5px; font-weight:600; padding:var(--sp-3) var(--sp-5); background:var(--surface); color:var(--text); border:1px solid var(--line-strong); border-radius:var(--r-sm); cursor:pointer")}>Withdraw</button>
                      </div>
                    </React.Fragment>))}
                  </div>
                </div>
              </>) : null}

              <div style={css("margin-top:var(--sp-4); background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:var(--sp-6); box-shadow:var(--e-1)")}>
                <h2 style={css("margin:0; font-size:18px; font-weight:600; letter-spacing:-.02em")}>Cash out to TRY</h2>
                <p style={css("margin:var(--sp-2) 0 0; font-size:14px; color:var(--muted)")}>
                  Convert your balance to lira through the anchor and send it to your bank account.</p>
                <button onClick={v.cashOut} style={css(v.ghostStyle)}>Withdraw to bank</button>
              </div>
            </div>
  );
}
