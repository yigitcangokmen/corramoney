/**
 * Channel accounts (Unit 5): in-memory leases, and the refusals of the only module that loads
 * channel keys. CI step "Channel key refusals" runs this file and setup-shape.test.ts.
 */
import * as S from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { buildPaymentAccountSetup, buildSponsoredSetup } from './build';
import { ChannelRefusal, createChannels, LEASE_MS, type ChannelDeps } from './channels';
import { createSponsor } from './sponsor';
import { canonical } from '../test/pool-fixtures';

const NP = S.Networks.TESTNET;
const NOW = 1_800_000_000;
const T = NOW * 1000;
const issuer = S.Keypair.random().publicKey();
const MXN = { code: 'TESTMXN', issuer };
const keys = Array.from({ length: 5 }, () => S.Keypair.random());
const secrets = keys.map((k) => k.secret());
const pks = keys.map((k) => k.publicKey());
const sponsorKey = S.Keypair.random();
const SP = sponsorKey.publicKey();
const trust = { trustIssuer: issuer, trustCodes: ['TESTMXN', 'TESTPHP'], maxTrust: 2 };
const sponsor = createSponsor(sponsorKey.secret(), NP, { ...trust, channels: pks });

/** A fake Horizon: settable sequences (null = no such account, 'throw' = an error), optional delay. */
function fake(start: bigint | null = 100n, delayMs = 0) {
  const seqs = new Map<string, bigint | null | 'throw'>(pks.map((pk) => [pk, start]));
  const sequenceOf = async (pk: string) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const v = seqs.get(pk);
    if (v === 'throw') throw new Error('horizon down');
    return v ?? null;
  };
  return { seqs, sequenceOf };
}
const make = (f = fake(), over: Partial<ChannelDeps> = {}) =>
  createChannels(secrets, { networkPassphrase: NP, sequenceOf: f.sequenceOf, allowed: pks, sponsor: SP, trust, ...over });

describe('channel leases', () => {
  it('CL1 five acquires give the five channels in configured order at their sequence; the sixth gives null', async () => {
    const ch = make();
    const got = [];
    for (let i = 0; i < 5; i++) got.push(await ch.acquire(1, T));
    expect(got).toEqual(pks.map((channel) => ({ channel, sequence: '100' })));
    expect(await ch.acquire(1, T)).toBeNull();
  });

  it('CL2 least recently used first: after release(c1), the never-used channels come before c1', async () => {
    const ch = make();
    expect((await ch.acquire(1, T))!.channel).toBe(pks[0]);
    ch.release(pks[0]);
    const order = [];
    for (let i = 0; i < 5; i++) order.push((await ch.acquire(1, T + 1000))!.channel);
    expect(order).toEqual([pks[1], pks[2], pks[3], pks[4], pks[0]]);
  });

  it('CL3 five concurrent acquires with a 50 ms Horizon read get five distinct channels (synchronous reservation)', async () => {
    const ch = make(fake(100n, 50));
    const got = await Promise.all(Array.from({ length: 5 }, () => ch.acquire(1, T)));
    expect(new Set(got.map((l) => l!.channel)).size).toBe(5);
  });

  it('CL4 a lease is held until t + LEASE_MS - 1 and free at t + LEASE_MS (315 s)', async () => {
    expect(LEASE_MS).toBe(315_000);
    const ch = make();
    for (let i = 0; i < 5; i++) await ch.acquire(1, T);
    expect(await ch.acquire(1, T + LEASE_MS - 1)).toBeNull();
    expect((await ch.acquire(1, T + LEASE_MS))!.channel).toBe(pks[0]);
  });

  it('CL5 early release only once the channel\'s sequence reaches the lease\'s last sequence', async () => {
    const f = fake();
    const ch = make(f);
    for (let i = 0; i < 5; i++) await ch.acquire(2, T);
    f.seqs.set(pks[2], 101n); // the payment-account setup landed, the account setup not yet
    expect(await ch.acquire(1, T + 1000)).toBeNull();
    f.seqs.set(pks[2], 102n);
    expect(await ch.acquire(1, T + 2000)).toEqual({ channel: pks[2], sequence: '102' });
  });

  it('CL6 a channel whose read is null or throws is skipped, not left leased, and parked until t + LEASE_MS', async () => {
    const f = fake();
    f.seqs.set(pks[0], null);
    f.seqs.set(pks[1], 'throw');
    const ch = make(f);
    expect((await ch.acquire(1, T))!.channel).toBe(pks[2]);
    f.seqs.set(pks[0], 100n);
    f.seqs.set(pks[1], 100n);
    expect((await ch.acquire(1, T + 1))!.channel).toBe(pks[3]);
    expect((await ch.acquire(1, T + 2))!.channel).toBe(pks[4]);
    expect(await ch.acquire(1, T + LEASE_MS - 1)).toBeNull();
    expect((await ch.acquire(1, T + LEASE_MS))!.channel).toBe(pks[0]);
    // Not left leased: the parked channel's lease was dropped, so it cannot sign.
    const none = make(fake(null));
    expect(await none.acquire(1, T)).toBeNull();
  });

  it('CL7 after an early release at S, a lagging read of S - 1 still leases at S', async () => {
    const f = fake();
    const ch = make(f);
    for (let i = 0; i < 5; i++) await ch.acquire(1, T);
    f.seqs.set(pks[0], 101n);
    expect(await ch.acquire(1, T + 1000)).toEqual({ channel: pks[0], sequence: '101' });
    ch.release(pks[0]);
    f.seqs.set(pks[0], 100n);
    expect(await ch.acquire(1, T + 2000)).toEqual({ channel: pks[0], sequence: '101' });
  });

  it('CL8 release frees the channel at once', async () => {
    const ch = make();
    for (let i = 0; i < 5; i++) await ch.acquire(1, T);
    ch.release(pks[3]);
    expect((await ch.acquire(1, T + 1))!.channel).toBe(pks[3]);
  });

  it('CL10 after a testnet reset (read null, parked) a re-funded channel leases at its new, lower sequence', async () => {
    const f = fake(5000n);
    const ch = make(f);
    for (let i = 0; i < 5; i++) await ch.acquire(1, T);
    for (const pk of pks) f.seqs.set(pk, null); // the reset: every channel gone
    expect(await ch.acquire(1, T + LEASE_MS)).toBeNull();
    for (const pk of pks) f.seqs.set(pk, 200n); // create-channels re-funds the same keys
    expect(await ch.acquire(1, T + 2 * LEASE_MS)).toEqual({ channel: pks[0], sequence: '200' });
  });

  it('CL13 a testnet reset never seen as a null read: a read far below the floor leases at the new on-chain sequence', async () => {
    const f = fake(5000n);
    const ch = make(f);
    expect(await ch.acquire(1, T)).toEqual({ channel: pks[0], sequence: '5000' });
    ch.release(pks[0]);
    for (const pk of pks) f.seqs.set(pk, 200n); // re-funded before any acquire read it as missing
    expect(await ch.acquire(1, T + 1000)).toEqual({ channel: pks[1], sequence: '200' });
    expect(await ch.acquire(1, T + 1000)).toEqual({ channel: pks[2], sequence: '200' });
    expect(await ch.acquire(1, T + 1000)).toEqual({ channel: pks[3], sequence: '200' });
    expect(await ch.acquire(1, T + 1000)).toEqual({ channel: pks[4], sequence: '200' });
    expect(await ch.acquire(1, T + 1000)).toEqual({ channel: pks[0], sequence: '200' });
  });

  it('CL11 a Horizon read that outlives LEASE_MS does not hand out the channel a later acquire took', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    let first = true;
    const ch = make({
      seqs: new Map(),
      sequenceOf: async (pk: string) => {
        if (pk === pks[0] && first) { first = false; await gate; }
        return 100n;
      },
    });
    const slow = ch.acquire(1, T); // reserves pks[0], its read hangs past LEASE_MS
    for (let i = 1; i < 5; i++) await ch.acquire(1, T + LEASE_MS);
    const fast = await ch.acquire(1, T + LEASE_MS);
    expect(fast).toEqual({ channel: pks[0], sequence: '100' });
    releaseFirst();
    // Every channel is now leased: the late acquire gets nothing, never pks[0] at 100 a second time.
    expect(await slow).toBeNull();
  });

  it('CL12 two concurrent acquires probing the same landed lease: only one re-leases it, the other gets null', async () => {
    const f = fake(100n, 20);
    const ch = make(f);
    for (let i = 0; i < 5; i++) await ch.acquire(1, T);
    f.seqs.set(pks[0], 101n); // pks[0]'s setup landed: its lease is over early
    const got = await Promise.all([ch.acquire(1, T + 1000), ch.acquire(1, T + 1000)]);
    expect(got.filter((l) => l?.channel === pks[0] && l.sequence === '101')).toHaveLength(1);
    expect(got.filter((l) => l === null)).toHaveLength(1);
  });

  it('CL9 createChannels refuses an empty list, an invalid seed, a duplicate, the sponsor, a key outside TESTNET_CHANNELS; no message holds a seed', () => {
    const f = fake();
    const deps = { networkPassphrase: NP, sequenceOf: f.sequenceOf, allowed: pks, sponsor: SP, trust };
    const bent = secrets[0].slice(0, -1) + (secrets[0].endsWith('A') ? 'B' : 'A');
    const cases: [readonly string[], Partial<ChannelDeps>, RegExp][] = [
      [[], {}, /no channel accounts/],
      [['not-a-seed'], {}, /not a valid seed/],
      [[bent], {}, /not a valid seed/],
      [[secrets[0], secrets[0]], {}, /duplicate channel key/],
      [[secrets[0], sponsorKey.secret()], { allowed: [...pks, SP] }, /cannot be the sponsor/],
      [[...secrets, S.Keypair.random().secret()], {}, /do not match packages\/shared\/src\/testnet-channels.ts/],
    ];
    for (const [list, over, reason] of cases) {
      let message = '';
      try {
        createChannels(list, { ...deps, ...over });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, String(reason)).toMatch(reason);
      expect(message).not.toMatch(/S[A-Z2-7]{55}/);
    }
  });
});

describe('channel signSetup refusals', () => {
  const P = S.Keypair.random();
  const z = S.Keypair.random();

  /** Five channels at 7000; the first leased for two transactions: (7000, 7002]. */
  async function leased(start = 7000n, txCount: 1 | 2 = 2) {
    const ch = make(fake(start));
    const lease = (await ch.acquire(txCount, T))!;
    return { ch, C: lease.channel };
  }
  const begin = (id: string, source = SP) => S.Operation.beginSponsoringFutureReserves({ sponsoredId: id, source });
  const create = (id: string, balance = '0') => S.Operation.createAccount({ destination: id, startingBalance: balance, source: SP });
  const line = (a: { code: string; issuer: string }, source?: string) => S.Operation.changeTrust({ asset: new S.Asset(a.code, a.issuer), ...(source ? { source } : {}) });
  const end = (id: string) => S.Operation.endSponsoringFutureReserves({ source: id });
  /** A new-account sandwich for `id`, by default P with TESTMXN. */
  const newAccount = (id = P.publicKey()) => [begin(id), create(id), line(MXN, id), end(id)];

  type Opts = { source: string; seq: bigint; fee: string; maxTime: number; memo: S.Memo; minAccountSequence: string };
  function tx(ops: S.xdr.Operation[], o: Partial<Opts> & { source: string }) {
    const b = new S.TransactionBuilder(new S.Account(o.source, ((o.seq ?? 7001n) - 1n).toString()), {
      fee: o.fee ?? '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: o.maxTime ?? NOW + 300 },
      ...(o.memo ? { memo: o.memo } : {}), ...(o.minAccountSequence ? { minAccountSequence: o.minAccountSequence } : {}),
    });
    for (const op of ops) b.addOperation(op);
    return b.build().toXDR();
  }

  it('CR1 accepts the canonical new-account setup: exactly one signature added, verifiable with the channel\'s key', async () => {
    const { ch, C } = await leased();
    const built = buildSponsoredSetup({
      networkPassphrase: NP, sponsor: SP, sponsorSequence: '1', txSource: { account: C, sequence: '7000' },
      account: P.publicKey(), accountExists: false, trust: [MXN], now: NOW,
    });
    const bySponsor = sponsor.signSetup(built.toXDR(), NOW);
    const signed = S.TransactionBuilder.fromXDR(ch.signSetup(bySponsor, C, NOW), NP) as S.Transaction;
    expect(signed.signatures).toHaveLength(2);
    expect(S.Keypair.fromPublicKey(C).verify(signed.hash(), signed.signatures[1].signature)).toBe(true);
  });

  it('CR2 accepts the payment-account setup at first + 1 and the account setup at first + 2', async () => {
    const { ch, C } = await leased();
    const pa = buildPaymentAccountSetup({
      networkPassphrase: NP, sponsor: SP, sponsorSequence: '1', txSource: { account: C, sequence: '7000' },
      sender: P.publicKey(), paymentAccount: z.publicKey(), now: NOW,
    });
    const own = buildSponsoredSetup({
      networkPassphrase: NP, sponsor: SP, sponsorSequence: '1', txSource: { account: C, sequence: '7001' },
      account: P.publicKey(), accountExists: false, trust: [MXN], now: NOW,
    });
    expect([pa.sequence, own.sequence]).toEqual(['7001', '7002']);
    expect(() => ch.signSetup(sponsor.signSetup(pa.toXDR(), NOW), C, NOW)).not.toThrow();
    expect(() => ch.signSetup(sponsor.signSetup(own.toXDR(), NOW), C, NOW)).not.toThrow();
  });

  it('CR3-CR7 refuses a trustline-only setup, a payment, a path payment, a contract call and a fee-bump', async () => {
    const { ch, C } = await leased();
    const p = P.publicKey();
    const refuse = (xdr: string, reason: RegExp) => expect(() => ch.signSetup(xdr, C, NOW), String(reason)).toThrow(reason);
    refuse(tx([begin(p), line(MXN, p), end(p)], { source: C }), /signs only a setup that creates a new account/);
    refuse(tx([S.Operation.payment({ destination: p, asset: S.Asset.native(), amount: '1', source: C })], { source: C }), /setup too short/);
    refuse(tx([S.Operation.pathPaymentStrictReceive({
      sendAsset: S.Asset.native(), sendMax: '1', destination: p, destAsset: new S.Asset(MXN.code, issuer), destAmount: '1', path: [],
    })], { source: C }), /setup too short/);
    // CR6 the pool fixture's invokeHostFunction with the channel as transaction source (fixture sequence 42).
    const at41 = await leased(41n, 1);
    const call = canonical('supply', (d) => { d.txSource = at41.C; });
    expect(() => at41.ch.signSetup(call, at41.C, NOW)).toThrow(/setup too short/);
    // The same value-moving ops inside a new-account sandwich, sourced by the account or the channel.
    const pay = (source: string) => S.Operation.payment({ destination: p, asset: S.Asset.native(), amount: '1', source });
    const path = (source: string) => S.Operation.pathPaymentStrictReceive({
      sendAsset: S.Asset.native(), sendMax: '1', destination: p, destAsset: new S.Asset(MXN.code, issuer), destAmount: '1', path: [], source,
    });
    for (const source of [p, C]) {
      refuse(tx([begin(p), create(p), pay(source), end(p)], { source: C }), /op not allowed in setup: payment/);
      refuse(tx([begin(p), create(p), path(source), end(p)], { source: C }), /op not allowed in setup: pathPaymentStrictReceive/);
    }
    // Long enough, but no sponsorship opened: two channel-sourced payments.
    refuse(tx([pay(C), pay(C)], { source: C }), /sponsor beginning sponsorship/);
    const inner = S.TransactionBuilder.fromXDR(tx(newAccount(), { source: C }), NP) as S.Transaction;
    const bump = S.TransactionBuilder.buildFeeBumpTransaction(C, '1000', inner, NP).toXDR();
    refuse(bump, /unexpected fee-bump/);
  });

  it('CR8-CR12 refuses value, sourceless and channel-sourced ops, and any channel as the account set up or as a signer', async () => {
    const { ch, C } = await leased();
    const p = P.publicKey();
    const C2 = pks.find((k) => k !== C)!;
    const refuse = (xdr: string, reason: RegExp) => expect(() => ch.signSetup(xdr, C, NOW), String(reason)).toThrow(reason);
    refuse(tx([begin(p), create(p, '1'), line(MXN, p), end(p)], { source: C }), /0 XLM/);
    refuse(tx([begin(p), create(p), line(MXN), end(p)], { source: C }), /changeTrust must be sourced by the sponsored account/);
    refuse(tx([begin(p), create(p), line(MXN, C2), end(p)], { source: C }), /changeTrust must be sourced by the sponsored account/);
    refuse(tx(newAccount(C), { source: C }), /a channel account cannot be set up/);
    refuse(tx(newAccount(C2), { source: C }), /a channel account cannot be set up/);
    const paWith = (zId: string, signer: string) => tx([begin(zId), create(zId), S.Operation.setOptions({
      source: zId, masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1, signer: { ed25519PublicKey: signer, weight: 1 },
    }), end(zId)], { source: C });
    refuse(paWith(z.publicKey(), C2), /cannot be set up or be a signer/);
    refuse(paWith(z.publicKey(), C), /cannot be set up or be a signer/);
    refuse(paWith(C2, p), /cannot be set up or be a signer/);
  });

  it('CR13-CR17 refuses other ops, foreign or too many trustlines, a long or past time bound, a high fee, a memo, a precondition', async () => {
    const { ch, C } = await leased();
    const p = P.publicKey();
    const refuse = (xdr: string, reason: RegExp) => expect(() => ch.signSetup(xdr, C, NOW), String(reason)).toThrow(reason);
    refuse(tx([begin(p), create(p), S.Operation.setOptions({ source: p, homeDomain: 'evil.example' }), end(p)], { source: C }), /setOptions|signer|weight/);
    refuse(tx([begin(p), create(p), S.Operation.accountMerge({ destination: C, source: p }), end(p)], { source: C }), /op not allowed in setup: accountMerge/);
    refuse(tx([begin(p), create(p), S.Operation.manageData({ name: 'x', value: 'y', source: p }), end(p)], { source: C }), /op not allowed in setup: manageData/);
    refuse(tx([begin(p), create(p), line({ code: 'TESTMXN', issuer: S.Keypair.random().publicKey() }, p), end(p)], { source: C }), /trustline asset not allowed/);
    // Three trustlines: a scope that allows three codes but at most two lines.
    const wide = createChannels(secrets, { networkPassphrase: NP, sequenceOf: fake(7000n).sequenceOf, allowed: pks, sponsor: SP,
      trust: { trustIssuer: issuer, trustCodes: ['TESTMXN', 'TESTPHP', 'TESTBRL'], maxTrust: 2 } });
    const W = (await wide.acquire(2, T))!.channel;
    const three = tx([begin(p), create(p), ...['TESTMXN', 'TESTPHP', 'TESTBRL'].map((code) => line({ code, issuer }, p)), end(p)], { source: W });
    expect(() => wide.signSetup(three, W, NOW)).toThrow(/too many trustlines/);
    refuse(tx(newAccount(), { source: C, maxTime: NOW + 301 }), /time bound within the next 5 minutes/);
    refuse(tx(newAccount(), { source: C, maxTime: NOW }), /time bound within the next 5 minutes/);
    refuse(tx(newAccount(), { source: C, fee: '1001' }), /fee above the sponsor's cap/);
    refuse(tx(newAccount(), { source: C, memo: S.Memo.text('hi') }), /carries no memo/);
    refuse(tx(newAccount(), { source: C, minAccountSequence: '5' }), /no other precondition/);
  });

  it('CR18-CR22 refuses another source, no or an expired lease, a sequence outside the lease, an unknown channel, a foreign sponsor', async () => {
    const { ch, C } = await leased();
    const C2 = pks.find((k) => k !== C)!;
    await ch.acquire(1, T); // C2 is leased too
    const ok = tx(newAccount(), { source: C });
    for (const source of [C2, SP, S.Keypair.random().publicKey()]) {
      expect(() => ch.signSetup(tx(newAccount(), { source }), C, NOW)).toThrow(/sourced by this channel account/);
    }
    const unleased = pks.find((k) => k !== C && k !== C2)!;
    expect(() => ch.signSetup(tx(newAccount(), { source: unleased }), unleased, NOW)).toThrow(/not leased/);
    expect(() => ch.signSetup(ok, C, NOW + LEASE_MS / 1000)).toThrow(/not leased/);
    expect(() => ch.signSetup(ok, C, NOW)).not.toThrow();
    for (const seq of [7000n, 7003n]) expect(() => ch.signSetup(tx(newAccount(), { source: C, seq }), C, NOW)).toThrow(/outside the channel's lease/);
    const stranger = S.Keypair.random().publicKey();
    expect(() => ch.signSetup(tx(newAccount(), { source: stranger }), stranger, NOW)).toThrow(/unknown channel account/);
    const p = P.publicKey();
    expect(() => ch.signSetup(tx([begin(p, stranger), create(p), line(MXN, p), end(p)], { source: C }), C, NOW)).toThrow(/sponsor beginning sponsorship/);
    expect(() => ch.signSetup(ok, stranger, NOW)).toThrow(ChannelRefusal);
  });
});
