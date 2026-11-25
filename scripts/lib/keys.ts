/**
 * Do the secrets in .env.testnet (or a rendered orchestrator.env) belong to the public keys the
 * generated files name? Pure over file texts; a secret never leaves these functions, only the
 * verdicts and public keys do. Stellar TESTNET only.
 */
import * as S from '@stellar/stellar-sdk';

/** .env.testnet secret -> the TESTNET field naming its public key. */
export const BASE_KEYS = {
  USDC_ISSUER_SECRET: 'usdcIssuer',
  CORRIDOR_ISSUER_SECRET: 'corridorIssuer',
  ANCHOR_DISTRIBUTION_SECRET: 'anchorDistribution',
  MARKET_MAKER_SECRET: 'marketMaker',
  FEE_SPONSOR_SECRET: 'feeSponsor',
  CLIENT_DOMAIN_SIGNING_SECRET: 'clientDomainSigner',
} as const;

/** KEY=value lines; comments and blanks skipped. */
export function envOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i < 1 || line.startsWith('#')) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** The public key of a secret, or null when it is not a valid one. */
export function publicOf(secret: string | undefined): string | null {
  if (!secret) return null;
  try {
    return S.Keypair.fromSecret(secret).publicKey();
  } catch {
    return null;
  }
}

/** `field: 'G...'` pairs of packages/shared/src/testnet.ts. */
export function testnetKeysOf(ts: string): Record<string, string> {
  return Object.fromEntries([...ts.matchAll(/^\s+(\w+): '(G[A-Z2-7]{55})',$/gm)].map((m) => [m[1], m[2]]));
}

/** The channel accounts of packages/shared/src/testnet-channels.ts, in order. */
export const channelsOf = (ts: string): string[] => [...ts.matchAll(/'(G[A-Z2-7]{55})'/g)].map((m) => m[1]);

/** The pool admin of packages/shared/src/testnet-blend.ts, or null (no pool, or Blend's admin). */
export const blendAdminOf = (ts: string): string | null => /\badmin: '(G[A-Z2-7]{55})'/.exec(ts)?.[1] ?? null;

export type KeyCheck = {
  /** The six base secrets name testnet.ts's keys. */
  base: 'ok' | 'mismatch' | 'missing';
  /** CHANNEL_SECRETS names testnet-channels.ts's five in order; todo when either side is absent. */
  channels: 'ok' | 'mismatch' | 'todo';
  /** POOL_ADMIN_SECRET names testnet-blend.ts's admin; todo when either side is absent. */
  poolAdmin: 'ok' | 'mismatch' | 'todo';
  problems: string[];
};

export function checkKeyFiles(f: { env: string; testnetTs: string; channelsTs: string; blendTs: string }): KeyCheck {
  const env = envOf(f.env);
  const pub = testnetKeysOf(f.testnetTs);
  const problems: string[] = [];
  let base: KeyCheck['base'] = 'ok';
  for (const [name, field] of Object.entries(BASE_KEYS)) {
    const pk = publicOf(env[name]);
    if (!pk) {
      problems.push(`${name} is missing or not a secret key`);
      if (base === 'ok') base = 'missing';
    } else if (pk !== pub[field]) {
      problems.push(`${name} is not the key of TESTNET.${field} (${pub[field] ?? 'absent'})`);
      base = 'mismatch';
    }
  }

  let channels: KeyCheck['channels'] = 'todo';
  const listed = channelsOf(f.channelsTs);
  if (env.CHANNEL_SECRETS && listed.length) {
    const mine = env.CHANNEL_SECRETS.split(',').map((x) => publicOf(x.trim()));
    channels = mine.length === listed.length && mine.every((pk, i) => pk === listed[i]) ? 'ok' : 'mismatch';
    if (channels === 'mismatch') problems.push('CHANNEL_SECRETS do not name the channel accounts of testnet-channels.ts, in order');
  }

  let poolAdmin: KeyCheck['poolAdmin'] = 'todo';
  const admin = blendAdminOf(f.blendTs);
  if (env.POOL_ADMIN_SECRET && admin) {
    poolAdmin = publicOf(env.POOL_ADMIN_SECRET) === admin ? 'ok' : 'mismatch';
    if (poolAdmin === 'mismatch') problems.push('POOL_ADMIN_SECRET is not the key of the pool admin in testnet-blend.ts');
  }
  return { base, channels, poolAdmin, problems };
}
