import React, { useEffect, useState } from 'react';
import { parseUnits } from '@corra/shared';
import { css } from '../logic/styles';
import { cashOutNote, depositNote, loadHistory, needsRefresh, safeLink, type HistoryRow } from '../logic/history';
import { POOL_UNKNOWN_TEXT, poolMoney } from '../logic/pool';
import type { Vals } from '../logic/vals';

const TONE: Record<string, string> = {
  CREDITED: 'var(--ink-brand)', EXPIRED: 'var(--amber)', CAP_EXCEEDED: 'var(--amber)', FAILED: 'var(--amber)',
};

const REFRESH_MS = 10_000;

const money = (a: string) => Number(a).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortRef = (s: string) => (s.length > 13 ? s.slice(0, 8) + '…' + s.slice(-4) : s);
const chipCss = "font-family:var(--mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); background:var(--sunken); border-radius:var(--r-xs); padding:2px var(--sp-2)";
const linkCss = "font-family:var(--mono); font-size:12px; color:var(--ink-brand)";
const DEPOSIT_TONE: Record<string, string> = { PENDING: 'var(--muted)', CONFIRMED: 'var(--ink-brand)', EXPIRED: 'var(--amber)' };

function DepositRow({ r }: { r: HistoryRow & { type: 'deposit' } }) {
  const d = r.d;
  const anchorLink = safeLink(d.moreInfoUrl);
  const why = depositNote(d);
  return (
    <div style={css("background:var(--surface); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-1); border:1px solid var(--line)")}>
      <div style={css("display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap")}>
        <span style={css("font-size:15.5px; font-weight:600")}>+{money(d.status === 'CONFIRMED' && d.credited ? d.credited.amount : d.requested.amount)} TESTMXN</span>
        <span style={css(chipCss)}>Deposit</span>
        <span style={css("margin-left:auto; font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; color:" + DEPOSIT_TONE[d.status])}>
          {d.status === 'PENDING' ? 'WAITING' : d.status}</span>
      </div>
      <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:12px; color:var(--muted); overflow-wrap:anywhere")}>
        {new Date(d.createdAt).toLocaleString()} · {d.anchorRef ? 'anchor ref ' + shortRef(d.anchorRef) : 'anchor record not linked'}
        {d.matchedBy ? ' · matched by ' + (d.matchedBy === 'callback_tx' ? 'callback' : d.matchedBy) : ''}</div>
      {anchorLink || d.txHash ? (
        <div style={css("margin-top:var(--sp-2); display:flex; gap:var(--sp-4); flex-wrap:wrap")}>
          {anchorLink ? <a href={anchorLink} target="_blank" rel="noopener noreferrer" style={css(linkCss)}>Anchor record</a> : null}
          {d.txHash ? <a href={'https://stellar.expert/explorer/testnet/tx/' + d.txHash} target="_blank" rel="noopener noreferrer" style={css(linkCss)}>On stellar.expert</a> : null}
        </div>
      ) : null}
      {why ? <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:12px; color:var(--amber)")}>{why}</div> : null}
    </div>
  );
}

const POOL_STATUS: Record<string, [string, string]> = {
  SUCCESS: ['Done', 'var(--ink-brand)'], FAILED: ['Failed', 'var(--amber)'], SUBMITTED: ['Pending', 'var(--muted)'],
};

export function PoolRow({ r }: { r: HistoryRow & { type: 'pool' } }) {
  const o = r.o;
  const unknown = o.status === 'FAILED' && o.resultCode === 'unknown';
  const [word, tone] = unknown ? ['Check the position', 'var(--amber)'] : POOL_STATUS[o.status] ?? [o.status, 'var(--muted)'];
  return (
    <div style={css("background:var(--surface); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-1); border:1px solid var(--line)")}>
      <div style={css("display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap")}>
        {/* A withdraw stores the requested amount; the pool clamps it to the position ('all' asks 1% over). */}
        <span style={css("font-size:15.5px; font-weight:600")}>{o.kind === 'withdraw' ? 'up to ' : ''}{poolMoney(parseUnits(o.amount.amount))} {o.amount.asset}</span>
        <span style={css(chipCss)}>{o.kind === 'supply' ? 'Moved to pool' : 'Taken back from pool'}</span>
        <span style={css("margin-left:auto; font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; color:" + tone)}>{word}</span>
      </div>
      <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:12px; color:var(--muted); overflow-wrap:anywhere")}>
        {new Date(o.createdAt).toLocaleString()}{o.ledger ? ' · fee paid by Corra · ledger ' + o.ledger : ''}</div>
      {o.txHash && o.ledger ? (
        <div style={css("margin-top:var(--sp-2); display:flex; gap:var(--sp-4); flex-wrap:wrap")}>
          <a href={'https://stellar.expert/explorer/testnet/tx/' + o.txHash} target="_blank" rel="noopener noreferrer" style={css(linkCss)}>On stellar.expert</a>
        </div>
      ) : null}
      {o.status === 'FAILED' && o.resultCode ? <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:12px; color:var(--amber)")}>{unknown ? POOL_UNKNOWN_TEXT : o.resultCode}</div> : null}
    </div>
  );
}

function PaymentRow({ r, track }: { r: HistoryRow & { type: 'sent' | 'received' }; track: (id: string) => void }) {
  const p = r.p;
  const cashedOut = r.type === 'received' ? cashOutNote(p) : '';
  return (
    <button onClick={() => track(p.id)}
      style={css("text-align:left; cursor:pointer; background:var(--surface); border-radius:var(--r-md); padding:var(--sp-5); box-shadow:var(--e-1); border:1px solid var(--line)")}>
      <div style={css("display:flex; align-items:center; gap:var(--sp-3); flex-wrap:wrap")}>
        <span style={css("font-size:15.5px; font-weight:600")}>{Number(p.quote.dest.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {p.quote.dest.asset}</span>
        <span style={css(chipCss)}>{r.type === 'sent' ? 'Sent' : 'Received'}</span>
        {cashedOut ? <span style={css(chipCss)}>{cashedOut}</span> : null}
        <span style={css("font-family:var(--mono); font-size:12px; color:var(--muted)")}>{p.publicId}</span>
        <span style={css("margin-left:auto; font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; color:" + (TONE[p.state] ?? 'var(--muted)'))}>{p.state}</span>
      </div>
      <div style={css("margin-top:var(--sp-2); font-family:var(--mono); font-size:12px; color:var(--muted)")}>
        {new Date(p.createdAt).toLocaleString()} · {r.type === 'received'
          ? <>from {p.senderAccount.slice(0, 6)}…{p.senderAccount.slice(-6)}</>
          : <>to {p.recipientAccount.slice(0, 6)}…{p.recipientAccount.slice(-6)}</>} · cap {Number(p.quote.maxSend.amount).toFixed(2)} TESTMXN{p.kind === 'balance' ? ' · from balance' : ''}</div>
    </button>
  );
}

export default function History({ v }: { v: Vals }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  // How many of the account's lists could not be loaded because the server did not answer.
  const [unreachable, setUnreachable] = useState(0);

  useEffect(() => {
    if (!v.historyPubkey) { setRows([]); setUnreachable(0); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pk = v.historyPubkey;
    const load = () => {
      loadHistory(pk).then((h) => {
        if (!live) return;
        setUnreachable(h.unreachable);
        setRows(h.rows);
        // While something is still settling (or the server did not answer), look again shortly.
        if (h.unreachable || needsRefresh(h.rows)) timer = setTimeout(load, REFRESH_MS);
      });
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [v.historyPubkey]);

  return (
    <div data-screen-label="History" style={css("max-width:820px; margin:0 auto; animation:dRise .34s cubic-bezier(.16,1,.3,1) both")}>
      <div style={css("display:flex; align-items:baseline; justify-content:space-between; gap:var(--sp-3); flex-wrap:wrap")}>
        <h2 style={css("margin:0; font-size:24px; font-weight:600; letter-spacing:-.02em")}>History</h2>
        <span style={css("font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--subtle)")}>
          {rows ? rows.length + (rows.length === 1 ? ' entry' : ' entries') : 'loading'}</span>
      </div>

      {unreachable ? (
        <div role="alert" style={css("margin-top:var(--sp-5); padding:var(--sp-4) var(--sp-5); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-md); font-size:13.5px; color:var(--amber)")}>
          Could not reach Corra's server, so some entries may be missing. Trying again.</div>
      ) : null}

      {rows && rows.length === 0 && !unreachable ? (
        <div style={css("margin-top:var(--sp-6); padding:var(--sp-9) var(--sp-6); background:var(--surface); border:1px dashed var(--line-strong); border-radius:var(--r-lg); text-align:center")}>
          <div style={css("font-size:17px; font-weight:600")}>{v.historyPubkey ? 'No activity yet' : 'Connect Freighter to see your activity'}</div>
          <div style={css("margin-top:var(--sp-2); font-size:14px; color:var(--muted)")}>Deposits and payments of this account show up here with their on-chain records.</div>
          <div style={css("margin-top:var(--sp-5); display:flex; gap:var(--sp-2); justify-content:center; flex-wrap:wrap")}>
            <button onClick={v.goBalance} style={css(v.ghostFlat)}>Add money</button>
            <button onClick={v.goSend} style={css(v.ctaFlat)}>Send money</button>
          </div>
        </div>
      ) : null}

      <div style={css("margin-top:var(--sp-5); display:flex; flex-direction:column; gap:var(--sp-2)")}>
        {(rows || []).map((r) => r.type === 'deposit'
          ? <DepositRow key={r.d.id} r={r} />
          : r.type === 'pool' ? <PoolRow key={r.o.id} r={r} />
          : <PaymentRow key={r.p.id} r={r} track={v.trackPayment} />)}
      </div>

      <div style={css("margin-top:var(--sp-5); padding:var(--sp-4) var(--sp-5); background:var(--amber-weak); border:1px solid var(--amber-line); border-radius:var(--r-md); font-size:13.5px; color:var(--amber)")}>
        Testnet. Every Stellar transaction is real and verifiable on stellar.expert. The SPEI cash-in at the anchor is
        simulated, the assets are team-issued test tokens, and no fiat moves.</div>
    </div>
  );
}
