import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TESTNET } from '@corra/shared';

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

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (run pnpm seed-testnet or set it in the environment)`);
  return v;
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
    /** The domain whose stellar.toml publishes Corra's SIGNING_KEY (what anchors see as client_domain). */
    clientDomain: process.env.CORRA_CLIENT_DOMAIN ?? 'host.docker.internal:8787',
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5180,http://localhost:5173,https://app.corra.money').split(','),
    reconcileEveryMs: Number(process.env.RECONCILE_EVERY_MS ?? 10_000),
    reconcileIdleMs: Number(process.env.RECONCILE_IDLE_MS ?? 30_000),
  };
}

export type Config = ReturnType<typeof loadConfig>;
