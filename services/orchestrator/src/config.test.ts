import { describe, expect, it } from 'vitest';
import * as S from '@stellar/stellar-sdk';
import { TESTNET } from '@corra/shared';
import { assertSponsorKey, localSetupLimitsOf } from './config';

describe('localSetupLimitsOf (CORRA_LOCAL_SETUP_LIMITS)', () => {
  it('LL2 unset is off; 1 with a localhost anchor is on; any other anchor, no anchor, or another value throws', () => {
    expect(localSetupLimitsOf({})).toBe(false);
    expect(localSetupLimitsOf({ CORRA_LOCAL_SETUP_LIMITS: '' })).toBe(false);
    expect(localSetupLimitsOf({ CORRA_LOCAL_SETUP_LIMITS: '1', ANCHOR_HOME_DOMAIN: 'http://localhost:8080' })).toBe(true);
    expect(() => localSetupLimitsOf({ CORRA_LOCAL_SETUP_LIMITS: '1', ANCHOR_HOME_DOMAIN: 'http://platform:8080' })).toThrow(/local stack only/);
    expect(() => localSetupLimitsOf({ CORRA_LOCAL_SETUP_LIMITS: '1' })).toThrow(/local stack only/);
    expect(() => localSetupLimitsOf({ CORRA_LOCAL_SETUP_LIMITS: 'yes', ANCHOR_HOME_DOMAIN: 'http://localhost:8080' })).toThrow(/must be 1 or unset/);
  });
});

describe('assertSponsorKey (S6-3)', () => {
  it('CF1 the sponsor key testnet.ts names passes', () => {
    expect(() => assertSponsorKey(TESTNET.feeSponsor)).not.toThrow();
  });

  it('CF2 another key throws, naming both', () => {
    const other = S.Keypair.random().publicKey();
    expect(() => assertSponsorKey(other)).toThrow(new RegExp(`${other}.*${TESTNET.feeSponsor}.*different seed runs`));
  });

  it('CF3 the message holds no secret-shaped string', () => {
    const kp = S.Keypair.random();
    let message = '';
    try {
      assertSponsorKey(kp.publicKey());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toMatch(/S[A-Z2-7]{55}/);
    expect(message).not.toContain(kp.secret());
  });
});
