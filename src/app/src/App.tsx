import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildVals } from './logic/vals';
import * as helpers from './logic/helpers';
import * as signing from './logic/signing';
import * as deposit from './logic/deposit';
import * as send from './logic/send';
import * as earn from './logic/earn';
import * as wallet from './logic/wallet';
import { VAULTS } from './logic/data';
import type { AppState, Ctl, Props } from './logic/types';
import TopBar from './components/TopBar';
import Tabs from './components/Tabs';
import Deposit from './components/Deposit';
import Send from './components/Send';
import Earn from './components/Earn';
import History from './components/History';
import SigningSheet from './components/SigningSheet';

const INITIAL: AppState = {
  tab:'deposit',
  depStep:'form', depDigits:'3500', depProg:0, depRef:8412,
  sendStep:1, sndDigits:'3500', pick:'PH', addr:'',
  elapsed:0, trackProg:0, sndRef:8412, saga:'cfbd94bf', txHash:'', ledger:0,
  pos:{}, vaultDigits:'', vaultPick:'blend',
  sign:null, signState:'ask',
  wallet:0,
  history:[],
  walletMode:'none', pubkey:null, secretKey:null, connecting:false
};

const PROPS: Props = { mxnPerUsd: 18.35, spread: 0.005 };

export default function App() {
  const [state, setState] = useState<AppState>(INITIAL);
  const live = useRef(state);
  live.current = state;
  const balPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const set = useCallback((patch: any) => {
    setState(prev => {
      const next = typeof patch === 'function' ? patch(prev) : patch;
      const merged: AppState = { ...prev, ...(next || {}) };
      live.current = merged;
      return merged;
    });
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
    c.pickedVault = () => helpers.pickedVault(c);
    c.totalVault = () => helpers.totalVault(c);
    c.totalEarned = () => helpers.totalEarned(c);
    c.log = (entry: any) => helpers.log(c, entry);
    c.stamp = () => helpers.stamp(c);
    c.hash = () => helpers.hash(c);

    c.ask = (sign: any) => signing.ask(c, sign);
    c.signReject = () => signing.signReject(c);
    c.signGo = () => signing.signGo(c);

    c.depGo = () => deposit.depGo(c);
    c.depSim = () => deposit.depSim(c);
    c.sndSign = () => send.sndSign(c);
    c.vaultGo = () => earn.vaultGo(c);
    c.vaultOut = (id: string) => earn.vaultOut(c, id);
    c.cashOut = () => earn.cashOut(c);

    c.connect = async () => {
      await wallet.connect(c);
      if (c.state.walletMode === 'none') return;
      if (balPollRef.current) clearInterval(balPollRef.current);
      balPollRef.current = setInterval(() => wallet.refreshBalances(c), 8000);
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
    const fast = setInterval(() => {
      set((s: AppState) => {
        const ids = Object.keys(s.pos);
        if (!ids.length) return null;
        const next: Record<string, any> = {};
        ids.forEach(id => {
          const p = s.pos[id], vault = VAULTS.find(x => x.id === id);
          if (!vault) return;
          next[id] = { amt:p.amt, at:p.at,
            earned: p.amt * (vault.apy / 100) / 31536000 * ((Date.now() - p.at) / 1000) };
        });
        return { pos:next };
      });
    }, 90);
    return () => {
      clearInterval(fast);
      if (balPollRef.current) clearInterval(balPollRef.current);
    };
  }, [set]);

  const v = buildVals(ctl);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div data-screen-label="Top bar" style={{
        position: 'sticky', top: 0, zIndex: 40,
        background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--line)' }}>
        <TopBar v={v} />
        <Tabs v={v} />
      </div>
      <div style={{ maxWidth: 1080, margin: '0 auto',
        padding: 'var(--sp-7) var(--sp-5) var(--sp-9)', boxSizing: 'border-box' }}>
        {v.isDeposit ? <Deposit v={v} /> : null}
        {v.isSend ? <Send v={v} /> : null}
        {v.isYield ? <Earn v={v} /> : null}
        {v.isHistory ? <History v={v} /> : null}
      </div>
      {v.signOpen ? <SigningSheet v={v} /> : null}
    </div>
  );
}
