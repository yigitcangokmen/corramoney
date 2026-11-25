import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TESTNET, TESTNET_BLEND, TESTNET_CHANNELS } from '@corra/shared';

/** Loads .env.testnet from the repo root without overriding variables already set. */
function loadEnvFile() {
  const path = fileURLToPath(new URL('../../../.env.testnet', import.meta.url));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i < 1 || line.startsWith('#')) continue;
    const k = line.slice(0, i);
    if (process.env[k] === undefined) process.env[k] = line.slice(i + 1);
  }
}

function required(name: string, hint = 'run pnpm seed-testnet or set it in the environment'): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (${hint})`);
  return v;
}

/**
 * CORRA_LOCAL_SETUP_LIMITS=1: higher /setup limits for a local stack that several scripts share from
 * one IP. Honoured only with ANCHOR_HOME_DOMAIN set to http://localhost..., so production (which
 * renders http://platform:8080) refuses to start with it.
 */
export function localSetupLimitsOf(env: NodeJS.ProcessEnv): boolean {
  const v = env.CORRA_LOCAL_SETUP_LIMITS;
  if (v === undefined || v === '') return false;
  if (v !== '1') throw new Error('CORRA_LOCAL_SETUP_LIMITS must be 1 or unset');
  if (!/^http:\/\/localhost(:\d+)?$/.test(env.ANCHOR_HOME_DOMAIN ?? '')) {
    throw new Error('CORRA_LOCAL_SETUP_LIMITS is for the local stack only (ANCHOR_HOME_DOMAIN must be http://localhost...)');
  }
  return true;
}

/** The web finds payment accounts by TESTNET.feeSponsor; a server holding another sponsor key would sponsor accounts the app never finds. */
export function assertSponsorKey(publicKey: string, expected: string = TESTNET.feeSponsor): void {
  if (publicKey !== expected) {
    throw new Error(`the fee-sponsor key is ${publicKey}, but packages/shared/src/testnet.ts names ${expected}: .env.testnet and testnet.ts are from different seed runs`);
  }
}

export function loadConfig() {
  loadEnvFile();
  return {
    port: Number(process.env.PORT ?? 8787),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://corra:corra@localhost:5434/corra',
    horizonUrl: process.env.HORIZON_URL ?? TESTNET.horizonUrl,
    networkPassphrase: TESTNET.networkPassphrase,
    corridorIssuer: TESTNET.corridorIssuer,
    anchorDistribution: process.env.ANCHOR_DISTRIBUTION ?? TESTNET.anchorDistribution,
    anchorId: process.env.ANCHOR_ID ?? 'corra-anchor',
    anchorHomeDomain: process.env.ANCHOR_HOME_DOMAIN ?? 'http://localhost:8080',
    anchorSigningKey: process.env.ANCHOR_SIGNING_KEY,
    feeSponsorSecret: required('FEE_SPONSOR_SECRET'),
    clientDomainSecret: required('CLIENT_DOMAIN_SIGNING_SECRET'),
    /** Channel account secrets, comma-separated (pnpm create-channels). */
    channelSecrets: required('CHANNEL_SECRETS', 'run pnpm create-channels').split(',').map((s) => s.trim()),
    channelPublicKeys: TESTNET_CHANNELS,
    localSetupLimits: localSetupLimitsOf(process.env),
    /** The domain whose stellar.toml publishes Corra's SIGNING_KEY (what anchors see as client_domain). */
    clientDomain: process.env.CORRA_CLIENT_DOMAIN ?? 'host.docker.internal:8787',
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5180,http://localhost:5173,https://app.corra.money').split(','),
    reconcileEveryMs: Number(process.env.RECONCILE_EVERY_MS ?? 10_000),
    reconcileIdleMs: Number(process.env.RECONCILE_IDLE_MS ?? 30_000),
    /** The Blend pool Corra fee-bumps `submit` for; the generated file is the single source (null: no pool routes). */
    pool: TESTNET_BLEND,
    rpcUrl: process.env.RPC_URL ?? TESTNET.rpcUrl,
    maxSorobanResourceFee: BigInt(process.env.MAX_SOROBAN_RESOURCE_FEE ?? '5000000'),
  };
}

export type Config = ReturnType<typeof loadConfig>;
