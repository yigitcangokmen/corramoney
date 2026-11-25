/**
 * The app's own Add money, send-from-balance and lending pool code against the local stack on Stellar
 * testnet: wallet.ts, deposit.ts, remit.ts, pool.ts, blend.ts, history.ts, api.ts, anchor.ts and vals.ts run unchanged in
 * Node. Only Freighter is replaced, by a fresh Keypair that signs what the app asks it to sign.
 * Never imported by the app (the bundle starts at main.tsx). Run through `pnpm local:check`, or
 *
 *   pnpm --filter @corra/web test:live
 *
 * Cost per run: one sponsored setup, 600 TESTMXN from the anchor, ~165 TESTMXN through the PHP book,
 * 20 TESTMXN into Corra's pool and back (two fee-bumps paid by the sponsor).
 */
import { describe, it, expect, vi } from 'vitest';
import type { AppState, Ctl } from '../logic/types';

const user = vi.hoisted(() => ({ kp: null as any }));
vi.mock('@stellar/freighter-api', async () => {
  const S = await import('@stellar/stellar-sdk');
  const NP = S.Networks.TESTNET;
  return {
    isConnected: async () => ({ isConnected: true }),
    requestAccess: async () => ({ address: user.kp.publicKey() }),
    getNetworkDetails: async () => ({ network: 'TESTNET', networkPassphrase: NP }),
    getAddress: async () => ({ address: user.kp.publicKey() }),
    signTransaction: async (xdr: string) => {
      const tx = S.TransactionBuilder.fromXDR(xdr, NP);
      tx.sign(user.kp);
      return { signedTxXdr: tx.toXDR(), signerAddress: user.kp.publicKey() };
    },
  };
});

const { Keypair } = await import('@stellar/stellar-sdk');
const { TESTNET } = await import('@corra/shared');
const helpers = await import('../logic/helpers');
const wallet = await import('../logic/wallet');
const deposit = await import('../logic/deposit');
const remit = await import('../logic/remit');
const pool = await import('../logic/pool');
const { loadHistory, safeLink } = await import('../logic/history');
const { api } = await import('../logic/api');
const { buildVals } = await import('../logic/vals');

const ANCHOR_BUSINESS = 'http://localhost:8091';
const tx = (h: string | null | undefined) => 'https://stellar.expert/explorer/testnet/tx/' + h;

function makeCTL(): Ctl & { state: AppState } {
  const state: AppState = {
    tab: 'balance', pick: 'PH', addr: '', remitStep: 'form', destDigits: '1000', quote: null, anchorQuote: null,
    setupDone: false, mxnTrusted: false, paymentAccount: null, anchorToken: null, anchorTokenExp: 0, payment: null, cashInUrl: null,
    remitBusy: null, remitError: null, trackError: null, popupBlocked: false, depositSkipped: false, freighterMissing: false,
    sign: null, signState: 'ask', wallet: 0, history: [],
    walletMode: 'none', pubkey: null, connecting: false,
    payFrom: 'anchor', walletSpendable: '0', otherBalances: {}, balanceAt: 0, balanceTriedAt: 0, balanceFails: 0, signedWaiting: false,
    depositStep: 'form', depositAmount: '', deposit: null, depositUrl: null, depositUrlAt: 0, depositBusy: null,
    depositError: null, depositPopupBlocked: false,
    poolRead: 'idle', pool: null, poolReadAt: 0, poolReadError: null, poolAmount: '', poolStep: 'form', poolBusy: null,
    poolError: null, poolDone: null, phpTrusted: false, phpSpendable: '0', cashOutRead: 'idle', cashOutRows: [], cashOutActive: null, cashOutBusy: null, cashOutError: null, cashOutPopupBlocked: false,
  };
  const c: any = {
    state, props: {}, rate: 18.35, spread: 0.005, minAmt: 200, maxAmt: 60000, trk: 0,
    set: (p: any) => Object.assign(state, typeof p === 'function' ? p(state) : p),
  };
  c.n = (v: number, d: number) => helpers.n(c, v, d);
  c.corr = () => helpers.corr(c);
  c.refreshBalances = () => wallet.refreshBalances(c);
  c.connect = () => wallet.connect(c);
  c.disconnect = () => wallet.disconnect(c);
  return c;
}

async function until(what: string, ms: number, ok: () => boolean | Promise<boolean>, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
}

const memory: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory[k] ?? null,
  setItem: (k: string, v: string) => { memory[k] = v; },
  removeItem: (k: string) => { delete memory[k]; },
});

describe('UI path on the local stack (Stellar testnet)', () => {
  it('connects, sets up, adds 600 TESTMXN, pays PHP 500 from the balance, moves 20 through the pool, and shows it all in History', async () => {
    user.kp = Keypair.random();
    const pk = user.kp.publicKey();
    const ctl = makeCTL();
    console.log('account ' + pk);

    // 1. Connect = SEP-10 at the anchor with Corra's client_domain. The first one after an
    //    orchestrator restart can fail once ("Unable to read client_domain's SIGNING_KEY").
    await wallet.connect(ctl);
    if (ctl.state.walletMode === 'none') {
      console.log('connect retry after: ' + ctl.state.remitError);
      await wallet.connect(ctl);
    }
    expect(ctl.state.remitError).toBeNull();
    expect(ctl.state.walletMode).toBe('freighter');
    expect(ctl.state.anchorToken).toBeTruthy();

    // 2. Set up your account (Balance tab).
    await deposit.setupAccount(ctl);
    expect(ctl.state.depositError).toBeNull();
    await until('the TESTMXN trustline on Horizon', 30_000, async () => {
      await ctl.refreshBalances();
      return ctl.state.setupDone && ctl.state.balanceAt > 0;
    });
    expect(buildVals(ctl).balanceState).toBe('empty');

    // 3. Add money 600.
    ctl.set({ depositAmount: '600' });
    await deposit.startAddMoney(ctl);
    expect(ctl.state.depositError).toBeNull();
    expect(ctl.state.depositStep).toBe('waiting');
    const d0 = ctl.state.deposit!;
    const page = ctl.state.depositUrl!;
    expect(page).toBeTruthy();
    const entry = deposit.rememberedDeposits(pk)[d0.id];
    expect(entry).toMatchObject({ linked: true });
    expect(d0.anchorRef).toBe(entry.ref);

    // 4. Simulate SPEI, as the anchor's page does.
    const sim = await fetch(ANCHOR_BUSINESS + '/sep24/simulate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: new URL(page).searchParams.get('token'), amount: '600.00' }),
    });
    expect(sim.status, await sim.clone().text()).toBe(200);

    // 5. The watcher turns the card to Added once the chain credit with the memo is seen.
    await until('the deposit to be CONFIRMED', 180_000, () => ctl.state.depositStep === 'credited');
    const d1 = ctl.state.deposit!;
    expect(['ref', 'callback_tx', 'chain']).toContain(d1.matchedBy);
    expect(d1.credited?.amount).toBe('600.0000000');
    let moreInfoUrl: string | null = d1.moreInfoUrl;
    await until('the anchor callback to store more_info_url', 30_000, async () => {
      moreInfoUrl = (await api.deposit(d1.id)).moreInfoUrl;
      return !!moreInfoUrl;
    }, 2000);
    expect(safeLink(moreInfoUrl)).not.toBeNull();
    expect(buildVals(ctl).depositCreditedText).toBe('Added 600.00 TESTMXN');

    // 6. History has the deposit with its anchor record.
    const h1 = await loadHistory(pk);
    const depRow = h1.rows.find((r) => r.type === 'deposit' && r.d.id === d1.id);
    expect(depRow?.type === 'deposit' && depRow.d.status).toBe('CONFIRMED');
    expect(depRow?.type === 'deposit' && depRow.d.anchorRef).toBeTruthy();

    // 7. Send PHP 500 to the demo recipient: Review offers the balance.
    await until('the 600 TESTMXN on Horizon', 30_000, async () => {
      await ctl.refreshBalances();
      return Number(ctl.state.walletSpendable) >= 600;
    });
    ctl.set({ tab: 'send', pick: 'PH', addr: TESTNET.demoRecipient, destDigits: '500' });
    await remit.getQuote(ctl);
    expect(ctl.state.remitError).toBeNull();
    expect(ctl.state.remitStep).toBe('review');
    expect(ctl.state.payFrom).toBe('balance');
    expect(buildVals(ctl).canPayFromBalance).toBe(true);
    expect(buildVals(ctl).promptsLeft).toBe(1);

    // 8. Sign and send: one signature, submitted at once, tracked to CREDITED.
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBeNull();
    expect(ctl.state.remitStep).toBe('track');
    expect(ctl.state.payment?.kind).toBe('balance');
    await until('the payment to be CREDITED', 120_000, () => ctl.state.payment?.state === 'CREDITED');
    const p = ctl.state.payment!;
    const evs = p.events ?? [];
    const settled = (evs.find((e) => e.type === 'CREDITED')?.data ?? evs.find((e) => e.type === 'ONCHAIN')?.data) as any;
    expect(typeof settled?.ledger).toBe('number');
    expect(buildVals(ctl).sagaSteps[3].detail).toContain('Settled in ledger');

    // 9. History has the payment, sent from the balance.
    const h2 = await loadHistory(pk);
    const sent = h2.rows.find((r) => r.type === 'sent' && r.p.id === p.id);
    expect(sent?.type === 'sent' && sent.p.kind).toBe('balance');

    // 10. Lending pool (D2): 20 in, all back, one signature each; Corra validates and pays the fee.
    ctl.set({ tab: 'balance' });
    await ctl.refreshBalances();
    await until('the pool to answer', 60_000, async () => {
      await pool.refreshPool(ctl);
      return ctl.state.poolRead === 'ready';
    }, 5000);
    expect(buildVals(ctl)).toMatchObject({ poolShown: true, poolRateText: '0.00% APR', poolStatusText: 'On-Ice (admin)' });
    ctl.set({ poolAmount: '20' });
    await pool.movePool(ctl, 'supply');
    expect(ctl.state.poolError).toBeNull();
    expect(ctl.state.poolStep).toBe('done');
    const supplied = ctl.state.poolDone!;
    await until('the position to read 20', 60_000, async () => {
      await pool.refreshPool(ctl);
      return ctl.state.pool?.underlyingRaw === 200_000_000n;
    }, 5000);
    expect(buildVals(ctl).poolPositionText).toBe('20.00');
    pool.resetPool(ctl);
    ctl.set({ poolAmount: 'all' });
    await pool.movePool(ctl, 'withdraw');
    expect(ctl.state.poolError).toBeNull();
    expect(ctl.state.poolStep).toBe('done');
    const withdrawn = ctl.state.poolDone!;
    await until('the position to read 0', 60_000, async () => {
      await pool.refreshPool(ctl);
      return ctl.state.pool?.underlyingRaw === 0n;
    }, 5000);
    const h3 = await loadHistory(pk);
    const poolRows = h3.rows.filter((r) => r.type === 'pool');
    expect(poolRows.map((r) => r.type === 'pool' && [r.o.kind, r.o.status])).toEqual([['withdraw', 'SUCCESS'], ['supply', 'SUCCESS']]);

    // 11. The evidence, public values only.
    console.log([
      'deposit     ' + d1.id,
      'anchor ref  ' + d1.anchorRef,
      'matched by  ' + d1.matchedBy,
      'credit tx   ' + tx(d1.txHash),
      'payment     ' + p.publicId,
      'settle tx   ' + tx(settled?.txHash ?? p.innerTxHash),
      'ledger      ' + settled?.ledger,
      'pool supply ' + tx(supplied.txHash),
      'pool back   ' + tx(withdrawn.txHash),
    ].join('\n'));
    remit.cancelRemit();
    deposit.cancelDeposit();
    pool.cancelPool();
  });
});
