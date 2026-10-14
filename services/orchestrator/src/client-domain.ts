/**
 * SEP-10 client_domain co-signing. The anchor only attributes a deposit to Corra (and sends
 * Corra its SEP-24 callbacks) when the login challenge carries a signature from the key Corra
 * publishes as SIGNING_KEY in its own stellar.toml.
 *
 * A SEP-10 challenge has sequence 0 and only manageData operations, so it can never be
 * submitted and moves no value. This module refuses anything else. It is one of the two places
 * the no-server-side-signing CI job allows a Keypair; the other is packages/stellar/src/sponsor.ts.
 */
import * as S from '@stellar/stellar-sdk';

export class ChallengeRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ChallengeRefusal';
  }
}

/** SEP-10 challenges live 15 minutes; allow a minute of clock skew on top. */
const MAX_CHALLENGE_TTL_SEC = 16 * 60;

export function createClientDomainSigner(secret: string, networkPassphrase: string, clientDomain: string) {
  const key = S.Keypair.fromSecret(secret);
  const me = key.publicKey();

  return {
    publicKey: me,

    /** `anchorSigningKey` is the anchor's own SEP-10 server key, which must source the challenge. */
    coSignChallenge(challengeXdr: string, anchorSigningKey: string, nowSec = Math.floor(Date.now() / 1000)): string {
      let tx: S.Transaction | S.FeeBumpTransaction;
      try {
        tx = S.TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
      } catch {
        throw new ChallengeRefusal('not a transaction for this network');
      }
      if (tx instanceof S.FeeBumpTransaction) throw new ChallengeRefusal('fee-bump is not a challenge');
      if (tx.source !== anchorSigningKey) throw new ChallengeRefusal('challenge is not from the anchor');
      if (tx.sequence !== '0') throw new ChallengeRefusal('challenge must have sequence 0');
      if (!tx.operations.length || tx.operations.some((op) => op.type !== 'manageData')) {
        throw new ChallengeRefusal('challenge must contain only manageData operations');
      }
      const clientDomainOp = tx.operations.find((op) => op.type === 'manageData' && op.name === 'client_domain');
      if (!clientDomainOp || clientDomainOp.source !== me) {
        throw new ChallengeRefusal('challenge has no client_domain operation for this key');
      }
      // Only logins attributed to Corra's own domain; never a signing service for other domains.
      const value = (clientDomainOp as S.Operation.ManageData).value;
      if (!value || Buffer.from(value).toString() !== clientDomain) {
        throw new ChallengeRefusal('challenge is for a different client domain');
      }
      const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
      if (!maxTime || maxTime <= nowSec || maxTime > nowSec + MAX_CHALLENGE_TTL_SEC) {
        throw new ChallengeRefusal('challenge time bounds are not those of a live SEP-10 challenge');
      }
      tx.sign(key);
      return tx.toXDR();
    },
  };
}
