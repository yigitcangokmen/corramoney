import { fiatAsset, sameAsset, type AssetId, type FiatCode } from '@corra/shared';
import { SagaError } from '@corra/settlement-saga';
import { buildPaymentAccountSetup, buildSponsoredSetup, type Channels, type Sponsor } from '@corra/stellar';

/** What /setup reads from the chain. */
export type SetupChain = {
  sponsorSequence(): Promise<string>;
  /** The account's classic trustlines, or null when the account does not exist. */
  trustlines(account: string): Promise<AssetId[] | null>;
  paymentAccountOf(account: string): Promise<string | null>;
};

/**
 * Sponsor-signed setup transactions, each for its signer to co-sign and submit:
 * - `paymentAccountXdr`: the sender's payment account, for the browser's throwaway key (no wallet
 *   prompt). Built only when the sender has none and the browser sent a key for one.
 * - `xdr`: the sender's own account and its missing trustlines, the Phase 1 shape, for the wallet.
 * The transaction source of one that creates an account is a leased channel account (channels.ts),
 * otherwise the sponsor; with all channels leased both are sponsor-sourced, as in Phase 1. Both use
 * the same source's sequence: the payment account takes the next one and must be submitted first;
 * the sender's own transaction takes the one after. The sponsor pays every reserve either way.
 */
export type SetupXdrs = { xdr?: string; paymentAccountXdr?: string };

export function createPrepareSetup(deps: {
  chain: SetupChain;
  sponsor: Sponsor;
  networkPassphrase: string;
  /** Absent: every setup is sponsor-sourced (the existing tests). */
  channels?: Channels;
  now?: () => number;
  log?: (line: { evt: string } & Record<string, unknown>) => void;
}) {
  const { chain, sponsor, channels } = deps;
  /**
   * null: nothing to set up. `admit` takes the account's own rate-limit token: only a setup that
   * builds the account's own sandwich spends it, and it is taken before any lease or signature.
   */
  return async function prepareSetup(account: string, trust: FiatCode[], paymentAccount?: string, admit?: () => boolean): Promise<SetupXdrs | null> {
    const [spSeq, lines, existing] = await Promise.all([
      chain.sponsorSequence(), chain.trustlines(account), chain.paymentAccountOf(account),
    ]);
    const missing = trust.map(fiatAsset).filter((a) => !lines?.some((l) => sameAsset(l, a)));
    const ownNeeded = lines === null || missing.length > 0;
    // An account that already has a payment account keeps it; the key sent for a new one is ignored.
    const paymentNeeded = !existing && !!paymentAccount;
    if (!ownNeeded && !paymentNeeded) return null;
    if (ownNeeded && admit && !admit()) throw new SagaError('RATE_LIMITED', 429, 'too many requests, try again later', true);
    // One clock for the lease and the builders' maxTime.
    const nowMs = (deps.now ?? Date.now)();
    const now = Math.floor(nowMs / 1000);
    const createsOwn = ownNeeded && lines === null;
    const txCount = (paymentNeeded ? 1 : 0) + (createsOwn ? 1 : 0);
    const lease = txCount && channels ? await channels.acquire(txCount as 1 | 2, nowMs) : null;
    if (txCount) {
      deps.log?.({
        evt: 'setup.channel', source: lease ? 'channel' : 'sponsor', channel: lease?.channel, txs: txCount,
        reason: lease ? undefined : channels ? 'all_leased' : 'no_channels',
      });
    }
    try {
      let chSeq = lease ? BigInt(lease.sequence) : 0n;
      let sSeq = BigInt(spSeq);
      /** A transaction that creates an account goes on the lease; anything else on the sponsor. */
      const source = (createsAccount: boolean) => (createsAccount && lease
        ? { sponsorSequence: spSeq, txSource: { account: lease.channel, sequence: (chSeq++).toString() } }
        : { sponsorSequence: (sSeq++).toString() });
      const sign = (tx: { toXDR(): string; source: string }) => {
        const signed = sponsor.signSetup(tx.toXDR(), now);
        return lease && tx.source === lease.channel ? channels!.signSetup(signed, lease.channel, now) : signed;
      };
      const out: SetupXdrs = {};
      if (paymentNeeded) {
        out.paymentAccountXdr = sign(buildPaymentAccountSetup({
          networkPassphrase: deps.networkPassphrase, sponsor: sponsor.publicKey, ...source(true),
          sender: account, paymentAccount: paymentAccount!, now,
        }));
      }
      if (ownNeeded) {
        out.xdr = sign(buildSponsoredSetup({
          networkPassphrase: deps.networkPassphrase, sponsor: sponsor.publicKey, ...source(createsOwn),
          account, accountExists: lines !== null, trust: missing, now,
        }));
      }
      return out;
    } catch (e) {
      if (lease) channels!.release(lease.channel);
      throw e;
    }
  };
}
