/**
 * Corra's channel accounts: friendbot-funded testnet accounts that are the transaction source of a
 * sponsored setup that creates an account, so several sign-ups at the same moment each get their own
 * sequence number. A channel pays only that setup's fee; it holds no user value, is never a signer,
 * never sources a payment or a contract call, and signs nothing but a setup that passes
 * assertSetupShape(requireCreateAccount). The ONLY module that loads channel keys (CI: 1 key load,
 * 1 signing site). Leases live in memory: one orchestrator process. A restart drops them (worst case
 * one setup fails tx_bad_seq; that /setup already spent the account's one per-account token, so a
 * brand-new account, or an existing one adding a trustline, can set up again only after up to
 * 10 minutes); a second process would need a Postgres advisory lock per channel (not built).
 */
import * as S from '@stellar/stellar-sdk';
import { SETUP_TTL_SEC } from './build';
import { assertSetupShape, SetupShapeError } from './setup-shape';

export class ChannelRefusal extends Error {
  name = 'ChannelRefusal';
}

/** A setup's maxTime plus 15 s of ledger close-time and clock slack: after it a leased setup can no longer land. */
export const LEASE_MS = (SETUP_TTL_SEC + 15) * 1000;

export type ChannelLease = {
  channel: string;
  /** on-chain sequence at acquire; the setups use +1, +2 */
  sequence: string;
};

export type Channels = {
  readonly publicKeys: readonly string[];
  /** The least recently used free channel for `txCount` setup transactions; null when none is free or readable. */
  acquire(txCount: 1 | 2, nowMs: number): Promise<ChannelLease | null>;
  /** Ends a lease none of whose transactions left the server (an error after acquire). */
  release(channel: string): void;
  /** Adds the channel's signature as transaction source; refuses anything but a setup that creates an account. */
  signSetup(setupXdr: string, channel: string, nowSec: number): string;
};

export type ChannelDeps = {
  networkPassphrase: string;
  /** The account's sequence, null when it does not exist (gateway.accountSequence). */
  sequenceOf(account: string): Promise<bigint | null>;
  /** Public keys the secrets must derive to: TESTNET_CHANNELS. */
  allowed: readonly string[];
  sponsor: string;
  trust: { trustIssuer: string; trustCodes: readonly string[]; maxTrust?: number };
};

/** A lease's sequence window is (first, last]; first is -1n while its sequence is still being read. */
type Lease = { until: number; first: bigint; last: bigint };
type Channel = { publicKey: string; key: S.Keypair; lastUsedMs: number; lease: Lease | null; parkedUntil: number; minSeq: bigint };

export function createChannels(secrets: readonly string[], deps: ChannelDeps): Channels {
  // Messages never carry a secret or anything derived from one.
  if (secrets.length < 1) throw new Error('no channel accounts: run pnpm create-channels');
  let keys: S.Keypair[];
  try {
    keys = secrets.map((s) => S.Keypair.fromSecret(s));
  } catch {
    throw new Error('a channel secret is not a valid seed');
  }
  const publicKeys = keys.map((k) => k.publicKey());
  if (new Set(publicKeys).size !== publicKeys.length) throw new Error('duplicate channel key');
  if (publicKeys.includes(deps.sponsor)) throw new Error('a channel cannot be the sponsor');
  if (!publicKeys.every((pk) => deps.allowed.includes(pk))) {
    throw new Error('the channel keys do not match packages/shared/src/testnet-channels.ts: run pnpm create-channels');
  }
  const channels: Channel[] = keys.map((key, i) => ({ publicKey: publicKeys[i], key, lastUsedMs: 0, lease: null, parkedUntil: 0, minSeq: 0n }));
  const byKey = new Map(channels.map((c) => [c.publicKey, c]));
  // Array.sort is stable: equal lastUsedMs keeps the configured order.
  const lru = (a: Channel, b: Channel) => a.lastUsedMs - b.lastUsedMs;
  const isFree = (c: Channel, nowMs: number) => (c.lease === null || c.lease.until <= nowMs) && c.parkedUntil <= nowMs;
  const read = (pk: string) => deps.sequenceOf(pk).catch(() => null);

  return {
    publicKeys,

    async acquire(txCount, nowMs) {
      for (const c of channels.filter((x) => isFree(x, nowMs)).sort(lru)) {
        // Another acquire may have taken it while this one awaited Horizon for an earlier candidate.
        if (!isFree(c, nowMs)) continue;
        // Reserved before the await, so a concurrent acquire skips it (no mutex, J-u5-5).
        const lease: Lease = { until: nowMs + LEASE_MS, first: -1n, last: -1n };
        const usedBefore = c.lastUsedMs;
        c.lease = lease;
        c.lastUsedMs = nowMs;
        let seq = await read(c.publicKey);
        // A read that outlived LEASE_MS: a concurrent acquire took the channel; leave its state alone.
        if (c.lease !== lease) continue;
        if (seq === null) {
          // Missing (after the testnet reset) or unreadable: not re-read on every request.
          c.lease = null;
          c.lastUsedMs = usedBefore;
          c.parkedUntil = nowMs + LEASE_MS;
          // A reset re-funds the same key at a lower sequence: the old floor must not outlive it.
          c.minSeq = 0n;
          continue;
        }
        // A lagging Horizon read after an early release must not hand out a sequence already used.
        // Lag is at most one lease (2 setups); a read further below is a reset that re-funded the key.
        if (seq < c.minSeq && c.minSeq - seq <= 2n) seq = c.minSeq;
        lease.first = seq;
        lease.last = seq + BigInt(txCount);
        c.minSeq = seq;
        return { channel: c.publicKey, sequence: seq.toString() };
      }

      // All leased: a lease whose last transaction already landed is over early.
      const held = channels.filter((c) => c.lease !== null && c.lease.until > nowMs && c.lease.first >= 0n);
      const probes = await Promise.all(held.map(async (c) => ({ c, lease: c.lease!, seq: await read(c.publicKey) })));
      for (const { c, lease, seq } of probes.sort((a, b) => lru(a.c, b.c))) {
        // The lease object must be the one probed: a concurrent acquire may already have taken it.
        if (seq === null || seq < lease.last || c.lease !== lease) continue;
        if (seq > c.minSeq) c.minSeq = seq;
        c.lease = { until: nowMs + LEASE_MS, first: seq, last: seq + BigInt(txCount) };
        c.lastUsedMs = nowMs;
        return { channel: c.publicKey, sequence: seq.toString() };
      }
      return null;
    },

    release(channel) {
      const c = byKey.get(channel);
      if (c) c.lease = null;
    },

    signSetup(setupXdr, channel, nowSec) {
      const c = byKey.get(channel);
      if (!c) throw new ChannelRefusal('unknown channel account');
      const tx = S.TransactionBuilder.fromXDR(setupXdr, deps.networkPassphrase);
      if (tx instanceof S.FeeBumpTransaction) throw new ChannelRefusal('unexpected fee-bump');
      if (tx.source !== channel) throw new ChannelRefusal('setup must be sourced by this channel account');
      const lease = c.lease;
      if (!lease || lease.first < 0n || lease.until <= nowSec * 1000) throw new ChannelRefusal('channel account is not leased');
      const seq = BigInt(tx.sequence);
      if (seq <= lease.first || seq > lease.last) throw new ChannelRefusal('sequence outside the channel\'s lease');
      try {
        assertSetupShape(tx, {
          sponsor: deps.sponsor, txSources: [channel], channels: publicKeys, ...deps.trust, requireCreateAccount: true, nowSec,
        });
      } catch (e) {
        if (e instanceof SetupShapeError) throw new ChannelRefusal(e.message);
        throw e;
      }
      tx.sign(c.key);
      return tx.toXDR();
    },
  };
}
