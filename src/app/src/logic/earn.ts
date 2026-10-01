import * as StellarSdk from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { horizon, USDC, DIST_SECRET, DIST_PUBLIC, NETWORK_PASSPHRASE } from './stellar';
import { VAULTS } from './data';
import { earnedOf } from './helpers';
import type { Ctl } from './types';

let _busy = false;

function savePositions(pubkey: string, pos: any) {
  try { localStorage.setItem('corra_pos_' + pubkey, JSON.stringify(pos)); } catch {}
}

export function loadPositions(pubkey: string): any {
  try {
    const raw = localStorage.getItem('corra_pos_' + pubkey);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function vaultGo(ctl: Ctl) {
  if (_busy) return;
  const v = parseFloat(ctl.state.vaultDigits) || 0;
  const t = ctl.pickedVault();
  if (v <= 0 || v > ctl.state.wallet) return;
  vaultDepositReal(ctl, v, t);
}

async function vaultDepositReal(ctl: Ctl, v: number, t: any) {
  _busy = true;
  try {
    const userPub = ctl.state.pubkey!;
    const amt = v.toFixed(7);
    const acct = await horizon.loadAccount(userPub);
    const tx = new StellarSdk.TransactionBuilder(acct, {
      fee:'100', networkPassphrase:NETWORK_PASSPHRASE
    }).addOperation(StellarSdk.Operation.payment({
      destination:DIST_PUBLIC, asset:USDC, amount:amt
    })).setTimeout(30).build();
    const sr = await signTransaction(tx.toXDR(), { networkPassphrase:NETWORK_PASSPHRASE });
    if (sr.error) throw new Error(sr.error);
    const signed = StellarSdk.TransactionBuilder.fromXDR(sr.signedTxXdr, NETWORK_PASSPHRASE);
    const result = await horizon.submitTransaction(signed as any);
    const txHash = result.hash || '';

    ctl.set((st: any) => {
      const cur = st.pos[t.id];
      const pos = Object.assign({}, st.pos);
      pos[t.id] = cur
        ? { amt: cur.amt + v, at: Date.now(), earned: cur.earned }
        : { amt: v, at: Date.now(), earned: 0 };
      savePositions(ctl.state.pubkey!, pos);
      return { pos, vaultDigits:'' };
    });
    await ctl.refreshBalances();
    ctl.log({ kind:'Vault deposit · ' + t.name, state:'Completed', tone:1,
      inAmt:ctl.n(v, 2) + ' USDC', outAmt:ctl.n(v, 2) + ' USDC',
      when:ctl.stamp(), tx:txHash });
  } catch(e) {
    console.error('Vault deposit failed:', e);
  } finally {
    _busy = false;
  }
}

export function vaultOut(ctl: Ctl, id: string) {
  if (_busy) return;
  const p = ctl.state.pos[id];
  const t = VAULTS.find(v => v.id === id)!;
  if (!p || p.amt <= 0) return;
  if (p.amt > 100000) return;
  const gained = earnedOf(p, t.apy);
  const back = p.amt + gained;
  vaultWithdrawReal(ctl, id, t, p, back, gained);
}

async function vaultWithdrawReal(ctl: Ctl, id: string, t: any, p: any, back: number, gained: number) {
  _busy = true;
  try {
    const userPub = ctl.state.pubkey!;
    const amt = back.toFixed(7);
    const userAcct = await horizon.loadAccount(userPub);
    const tx = new StellarSdk.TransactionBuilder(userAcct, {
      fee:'100', networkPassphrase:NETWORK_PASSPHRASE
    }).addOperation(StellarSdk.Operation.payment({
      source:DIST_PUBLIC, destination:userPub, asset:USDC, amount:amt
    })).setTimeout(30).build();
    tx.sign(StellarSdk.Keypair.fromSecret(DIST_SECRET));
    const sr = await signTransaction(tx.toXDR(), { networkPassphrase:NETWORK_PASSPHRASE });
    if (sr.error) throw new Error(sr.error);
    const signed = StellarSdk.TransactionBuilder.fromXDR(sr.signedTxXdr, NETWORK_PASSPHRASE);
    const result = await horizon.submitTransaction(signed as any);
    const txHash = result.hash || '';

    ctl.log({ kind:'Vault withdrawal · ' + t.name, state:'Completed', tone:1,
      inAmt:ctl.n(p.amt, 2) + ' USDC', outAmt:ctl.n(back, 7) + ' USDC',
      earned:'+' + ctl.n(gained, 7) + ' USDC',
      when:ctl.stamp(), tx:txHash });
    ctl.set((st: any) => {
      const pos = Object.assign({}, st.pos);
      delete pos[id];
      savePositions(ctl.state.pubkey!, pos);
      return { pos };
    });
    await ctl.refreshBalances();
  } catch(e) {
    console.error('Vault withdraw failed:', e);
  } finally {
    _busy = false;
  }
}

export function cashOut(ctl: Ctl) {
  if (_busy) return;
  const w = ctl.state.wallet;
  if (w <= 0) return;
  cashOutReal(ctl, w);
}

async function cashOutReal(ctl: Ctl, w: number) {
  _busy = true;
  try {
    const userPub = ctl.state.pubkey!;
    const amt = w.toFixed(7);
    const acct = await horizon.loadAccount(userPub);
    const tx = new StellarSdk.TransactionBuilder(acct, {
      fee:'100', networkPassphrase:NETWORK_PASSPHRASE
    }).addOperation(StellarSdk.Operation.payment({
      destination:DIST_PUBLIC, asset:USDC, amount:amt
    })).setTimeout(30).build();
    const sr = await signTransaction(tx.toXDR(), { networkPassphrase:NETWORK_PASSPHRASE });
    if (sr.error) throw new Error(sr.error);
    const signed = StellarSdk.TransactionBuilder.fromXDR(sr.signedTxXdr, NETWORK_PASSPHRASE);
    const result = await horizon.submitTransaction(signed as any);

    ctl.log({ kind:'MXN withdrawal', state:'Awaiting bank', tone:0,
      inAmt:ctl.n(w, 2) + ' USDC', outAmt:'MX$' + ctl.n(w * ctl.rate, 2),
      when:ctl.stamp(), tx:result.hash || '' });
    await ctl.refreshBalances();
    savePositions(ctl.state.pubkey!, {});
    ctl.set({ tab:'history', pos:{} });
  } catch(e) {
    console.error('Cash out failed:', e);
  } finally {
    _busy = false;
  }
}
