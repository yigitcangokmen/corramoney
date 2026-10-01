import React, { useCallback, useMemo, useRef, useState } from 'react';
import { buildVals } from './logic/vals';
import * as helpers from './logic/helpers';
import * as signing from './logic/signing';
import * as deposit from './logic/deposit';
import * as send from './logic/send';
import * as earn from './logic/earn';
import { useYieldAccrual } from './hooks/useYieldAccrual';
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
  depStep:'form', depDigits:'500', depProg:0, depRef:8412,
  sendStep:1, sndDigits:'1000', pick:'PH', addr:'',
  elapsed:0, trackProg:0, sndRef:8412, saga:'cfbd94bf', txHash:'', ledger:0,
  pos:{}, vaultDigits:'', vaultPick:'blend',
  sign:null, signState:'ask',
  wallet:270.70,
  history:[]
};

const PROPS: Props = { tryPerUsd: 48.7702, spread: 0.005 };

export default function App() {
  const [state, setState] = useState<AppState>(INITIAL);
  const live = useRef(state);
  live.current = state;

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
    Object.defineProperty(c, 'rate', { get: () => PROPS.tryPerUsd ?? 48.7702 });
    Object.defineProperty(c, 'spread', { get: () => PROPS.spread ?? 0.005 });
    Object.defineProperty(c, 'minAmt', { get: () => 50 });
    Object.defineProperty(c, 'maxAmt', { get: () => 3000 });

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
    c.sndSim = () => send.sndSim(c);
    c.vaultGo = () => earn.vaultGo(c);
    c.vaultOut = (id: string) => earn.vaultOut(c, id);
    c.cashOut = () => earn.cashOut(c);
    c.reset = () => earn.reset(c);

    return c as Ctl;
  }, [set]);

  useYieldAccrual();

  const v = buildVals(ctl);

  return (
    <div>
      <TopBar v={v} />
      <Tabs v={v} />
      <div style={{ maxWidth: '1080px', margin: '0 auto',
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
