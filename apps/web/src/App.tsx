import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildVals } from './logic/vals';
import * as helpers from './logic/helpers';
import * as signing from './logic/signing';
import * as remit from './logic/remit';
import * as wallet from './logic/wallet';
import * as deposit from './logic/deposit';
import * as pool from './logic/pool';
import * as cashout from './logic/cashout';
import type { AppState, Ctl, Props } from './logic/types';
import TopBar from './components/TopBar';
import Tabs from './components/Tabs';
import Send from './components/Send';
import Balance from './components/Balance';
import History from './components/History';
import CashOut from './components/CashOut';
import SigningSheet from './components/SigningSheet';

const INITIAL: AppState = {
  tab:'send',
  pick:'PH', addr:'',
  remitStep:'form', destDigits:'1000', quote:null, anchorQuote:null, setupDone:false, mxnTrusted:false, paymentAccount:null,
  anchorToken:null, anchorTokenExp:0, payment:null, cashInUrl:null,
  remitBusy:null, remitError:null, trackError:null, popupBlocked:false, depositSkipped:false, freighterMissing:false,
  sign:null, signState:'ask',
  wallet:0,
  history:[],
  walletMode:'none', pubkey:null, connecting:false,
  payFrom:'anchor', walletSpendable:'0', otherBalances:{}, balanceAt:0, balanceTriedAt:0, balanceFails:0, signedWaiting:false,
  depositStep:'form', depositAmount:'', deposit:null, depositUrl:null, depositUrlAt:0, depositBusy:null,
  depositError:null, depositPopupBlocked:false,
  poolRead:'idle', pool:null, poolReadAt:0, poolReadError:null, poolAmount:'', poolStep:'form', poolBusy:null,
  poolError:null, poolDone:null,
  phpTrusted:false, phpSpendable:'0', cashOutRead:'idle', cashOutRows:[], cashOutActive:null, cashOutBusy:null,
  cashOutError:null, cashOutPopupBlocked:false
};

const PROPS: Props = { mxnPerUsd: 18.35, spread: 0.005 };

export default function App() {
  const [state, setState] = useState<AppState>(INITIAL);
  const live = useRef(state);
  live.current = state;
  const balPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ctl.state must read the patch at once: React may run a setState updater only at the next
  // render, and c.connect reads walletMode right after wallet.connect's last set.
  const set = useCallback((patch: any) => {
    const next = typeof patch === 'function' ? patch(live.current) : patch;
    const merged: AppState = { ...live.current, ...(next || {}) };
    live.current = merged;
    setState(merged);
  }, []);

  const ctl = useMemo(() => {
    const c: any = { props: PROPS, set };
    Object.defineProperty(c, 'state', { get: () => live.current });
    Object.defineProperty(c, 'rate', { get: () => PROPS.mxnPerUsd ?? 18.35 });
    Object.defineProperty(c, 'spread', { get: () => PROPS.spread ?? 0.005 });
    Object.defineProperty(c, 'minAmt', { get: () => 200 });
    Object.defineProperty(c, 'maxAmt', { get: () => 60000 });

    c.n = (val: number, d: number) => helpers.n(c, val, d);
    c.amt = (k: string) => helpers.amt(c, k);
    c.usdc = (t: number) => helpers.usdc(c, t);
    c.corr = () => helpers.corr(c);
    c.log = (entry: any) => helpers.log(c, entry);
    c.stamp = () => helpers.stamp(c);
    c.hash = () => helpers.hash(c);

    c.ask = (sign: any) => signing.ask(c, sign);
    c.signReject = () => signing.signReject(c);
    c.signGo = () => signing.signGo(c);

    c.getQuote = () => remit.getQuote(c);
    c.signAndSend = () => remit.signAndSend(c);
    c.resend = () => remit.resend(c);
    c.track = (id: string) => remit.track(c, id);
    c.resetRemit = () => remit.resetRemit(c);
    c.restartDeposit = () => remit.restartDeposit(c);
    c.openDepositWindow = () => remit.openDepositWindow(c);
    c.addMoney = () => deposit.startAddMoney(c);
    c.setupAccount = () => deposit.setupAccount(c);
    c.openAnchorPage = () => deposit.openAnchorPage(c);
    c.resetDeposit = () => deposit.resetDeposit(c);
    c.movePool = (kind: 'supply' | 'withdraw') => pool.movePool(c, kind);
    c.resetPool = () => pool.resetPool(c);
    c.refreshCashOuts = () => cashout.refreshCashOuts(c);
    c.setupCashOut = () => cashout.setupCashOut(c);
    c.startCashOut = (id: string) => cashout.startCashOut(c, id);
    c.signCashOut = () => cashout.signCashOut(c);
    c.openCashOutPage = () => cashout.openCashOutPage(c);
    c.resetCashOut = () => cashout.resetCashOut(c);

    c.connect = async () => {
      await wallet.connect(c);
      if (c.state.walletMode === 'none') return;
      if (balPollRef.current) clearInterval(balPollRef.current);
      // The pool position and the Cash out list ride the same 8 s tick, only while their tab is open.
      pool.refreshPool(c);
      if (c.state.tab === 'cashout') cashout.refreshCashOuts(c);
      balPollRef.current = setInterval(() => {
        wallet.refreshBalances(c);
        if (c.state.tab === 'balance') pool.refreshPool(c);
        if (c.state.tab === 'cashout') cashout.refreshCashOuts(c);
      }, 8000);
    };
    c.disconnect = () => {
      if (balPollRef.current) clearInterval(balPollRef.current);
      balPollRef.current = null;
      wallet.disconnect(c);
    };
    c.refreshBalances = () => wallet.refreshBalances(c);

    return c as Ctl;
  }, [set]);

  useEffect(() => {
    return () => {
      if (balPollRef.current) clearInterval(balPollRef.current);
    };
  }, [set]);

  // Browsers slow a background tab's timers: one fresh read when the tab is shown again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && ctl.state.walletMode === 'freighter') wallet.refreshBalances(ctl).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [ctl]);

  const v = buildVals(ctl);

  const [hideMissing, setHideMissing] = useState(false);
  // A connect error toast goes away on its own; errors after connecting stay in the form.
  const connectError = !v.isConnected ? v.errorText : null;
  useEffect(() => {
    if (!connectError) return;
    const t = setTimeout(() => ctl.set({ remitError: null }), 8000);
    return () => clearTimeout(t);
  }, [connectError, ctl]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div data-screen-label="Top bar" style={{
        position: 'sticky', top: 0, zIndex: 40,
        background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--line)' }}>
        <TopBar v={v} />
        <Tabs v={v} />
        {/* On the Send form the card's own Connect button shows these; elsewhere, a toast that hangs
            just below the header (tabs included), so it never covers them. */}
        {!v.isConnected && !(v.isSend && v.remitForm) && ((v.freighterMissing && !hideMissing) || v.busyText || v.errorText) ? (
          <div role={v.errorText || v.freighterMissing ? 'alert' : 'status'} aria-live="polite" style={{
            position: 'absolute', top: 'calc(100% + var(--sp-3))', right: 'var(--sp-5)', zIndex: 50,
            maxWidth: 'min(380px, calc(100vw - 2 * var(--sp-5)))', boxSizing: 'border-box',
            display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-3)',
            padding: 'var(--sp-3) var(--sp-4)', borderRadius: 'var(--r-md)', boxShadow: 'var(--e-2)', fontSize: 13.5,
            background: v.errorText || v.freighterMissing ? 'var(--amber-weak)' : 'var(--surface)',
            border: '1px solid ' + (v.errorText || v.freighterMissing ? 'var(--amber-line)' : 'var(--line)'),
            color: v.errorText || v.freighterMissing ? 'var(--amber)' : 'var(--ink-brand)' }}>
            <span>
              {v.errorText ?? v.busyText ??
                <>Freighter is not installed. <a href="https://www.freighter.app/" target="_blank" rel="noopener">Install Freighter</a>, then reload.</>}
            </span>
            {v.errorText || v.freighterMissing ? (
              <button aria-label="Dismiss" onClick={() => (v.errorText ? ctl.set({ remitError: null }) : setHideMissing(true))} style={{
                border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto',
        padding: 'var(--sp-7) var(--sp-5) var(--sp-9)', boxSizing: 'border-box' }}>
        {v.isSend ? <Send v={v} /> : null}
        {v.isBalance ? <Balance v={v} /> : null}
        {v.isCashOut ? <CashOut v={v} /> : null}
        {v.isHistory ? <History v={v} /> : null}
      </div>
      {v.signOpen ? <SigningSheet v={v} /> : null}
    </div>
  );
}
