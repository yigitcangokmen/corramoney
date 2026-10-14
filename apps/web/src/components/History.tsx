import React, { useEffect, useState } from 'react';
import { css } from '../logic/styles';
import { api, ApiError, TERMINAL } from '../logic/api';
import { rememberedPayments, type TrackedPayment } from '../logic/remit';
import type { Vals } from '../logic/vals';

const TONE: Record<string, string> = {
  CREDITED: 'var(--ink-brand)', EXPIRED: 'var(--amber)', CAP_EXCEEDED: 'var(--amber)', FAILED: 'var(--amber)',
};

const REFRESH_MS = 10_000;

export default function History({ v }: { v: Vals }) {
  const [rows, setRows] = useState<TrackedPayment[] | null>(null);
  // How many remembered payments could not be loaded because the server did not answer (404s are just gone).
  const [unreachable, setUnreachable] = useState(0);

  useEffect(() => {
    if (!v.historyPubkey) { setRows([]); setUnreachable(0); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = rememberedPayments(v.historyPubkey);
    const load = () => {
      let lost = 0;
      Promise.all(ids.map((id) => api.payment(id).catch((e) => {
        if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) lost++;
        return null;
      }))).then((ps) => {
        if (!live) return;
        const got = ps.filter(Boolean) as TrackedPayment[];
        setUnreachable(lost);
        setRows(got);
        // While a payment is still settling (or the server did not answer), look again shortly.
        if (lost || got.some((p) => !TERMINAL.includes(p.state))) timer = setTimeout(load, REFRESH_MS);
      });
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [v.historyPubkey]);

  return (
    <div data-screen-label="History" style={css("max-width:820px; margin:0 auto; animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>
      <div style={css("display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3); flex-wrap:wrap")}>
        <h2 style={css("margin:0; font-size:24px; font-weight:600; letter-spacing:-.02em")}>Payments</h2>
        <span style={css("font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--subtle)")}>
          {rows ? rows.length + (rows.length === 1 ? ' payment' : ' payments') : 'loading'}</span>
      </div>

      {unreachable ? (
        <div role="alert" style={css("margin-top:var(--sp-5); padding:var(--sp-4) var(--sp-5); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-md); font-size:13.5px; color:var(--amber)")}>
          Could not reach Corra's server, so {unreachable === 1 ? '1 payment is' : unreachable + ' payments are'} missing below. Try again in a moment.</div>
      ) : null}

      {rows && rows.length === 0 && !unreachable ? (
        <div style={css("margin-top:var(--sp-6); padding:var(--sp-9) var(--sp-6); background:var(--surface); border:1px dashed var(--line-strong); border-radius:var(--r-lg); text-align:center")}>
          <div style={css("font-size:17px; font-weight:600")}>{v.historyPubkey ? 'No payments yet' : 'Connect Freighter to see your payments'}</div>
          <div style={css("margin-top:var(--sp-2); font-size:14px; color:var(--muted)")}>Every payment you send from this browser shows up here with its on-chain timeline.</div>
          <button onClick={v.goSend} style={css(v.ctaFlat + " margin-top:var(--sp-5);")}>Send money</button>
        </div>
      ) : null}

      <div style={css("margin-top:var(--sp-5); display:flex; flex-direction:column; gap:var(--sp-2)")}>
        {(rows || []).map((p) => (
          <button key={p.id} onClick={() => v.trackPayment(p.id)}
            style={css("text-align:left; cursor:pointer; background:var(--surface); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-1); border:1px solid var(--line)")}>
            <div style={css("display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap")}>
              <span style={css("font-size:15.5px; font-weight:600")}>{Number(p.quote.dest.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {p.quote.dest.asset}</span>
              <span style={css("font-family:var(--mono); font-size:12px; color:var(--muted)")}>{p.publicId}</span>
              <span style={css("margin-left:auto; font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; color:" + (TONE[p.state] ?? 'var(--muted)'))}>{p.state}</span>
            </div>
            <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:12px; color:var(--muted)")}>
              {new Date(p.createdAt).toLocaleString()} · to {p.recipientAccount.slice(0, 6)}…{p.recipientAccount.slice(-6)} · cap {Number(p.quote.maxSend.amount).toFixed(2)} TESTMXN</div>
          </button>
        ))}
      </div>

      <div style={css("margin-top:var(--sp-5); padding:var(--sp-4) var(--sp-5); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-md); font-size:13.5px; color:var(--amber)")}>
        Testnet. Every Stellar transaction is real and verifiable on stellar.expert. The SPEI cash-in at the anchor is
        simulated, the assets are team-issued test tokens, and no fiat moves.</div>
    </div>
  );
}
