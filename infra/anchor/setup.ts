/**
 * Renders the Anchor Platform config for the current testnet accounts into infra/anchor/generated/
 * (gitignored). Re-run after `pnpm seed-testnet`. Existing anchor secrets are kept, so the
 * anchor's SEP-10 SIGNING_KEY stays stable across runs.
 *
 *   pnpm exec tsx infra/anchor/setup.ts
 */
import * as S from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TESTNET } from '../../packages/shared/src/testnet';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
// ANCHOR_CONFIG_OUT lets the production deploy render its own config (and its own secrets)
// without touching the local one.
const out = process.env.ANCHOR_CONFIG_OUT ?? join(here, 'generated');
mkdirSync(out, { recursive: true });

const parseEnv = (path: string): Record<string, string> =>
  existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      )
    : {};

const testnet = parseEnv(join(root, '.env.testnet'));
if (!testnet.ANCHOR_DISTRIBUTION_SECRET) throw new Error('.env.testnet missing; run pnpm seed-testnet first');
if (S.Keypair.fromSecret(testnet.ANCHOR_DISTRIBUTION_SECRET).publicKey() !== TESTNET.anchorDistribution) {
  throw new Error('.env.testnet and packages/shared/src/testnet.ts are from different seed runs');
}

const secretsPath = join(out, 'platform.secrets.env');
const prev = parseEnv(secretsPath);
const hex = () => randomBytes(32).toString('hex');
const secrets = {
  SECRET_SEP10_SIGNING_SEED: prev.SECRET_SEP10_SIGNING_SEED ?? S.Keypair.random().secret(),
  SECRET_SEP10_JWT_SECRET: prev.SECRET_SEP10_JWT_SECRET ?? hex(),
  SECRET_SEP24_INTERACTIVE_URL_JWT_SECRET: prev.SECRET_SEP24_INTERACTIVE_URL_JWT_SECRET ?? hex(),
  SECRET_SEP24_MORE_INFO_URL_JWT_SECRET: prev.SECRET_SEP24_MORE_INFO_URL_JWT_SECRET ?? hex(),
};
const sep10Key = S.Keypair.fromSecret(secrets.SECRET_SEP10_SIGNING_SEED).publicKey();

const vars: Record<string, string> = {
  CORRIDOR_ISSUER: TESTNET.corridorIssuer,
  ANCHOR_DISTRIBUTION: TESTNET.anchorDistribution,
  SEP10_SIGNING_KEY: sep10Key,
  ANCHOR_PUBLIC_URL: process.env.ANCHOR_PUBLIC_URL ?? 'http://localhost:8080',
  CORRA_CLIENT_DOMAIN: process.env.CORRA_CLIENT_DOMAIN ?? 'host.docker.internal:8787',
  CORRA_CALLBACK_URL: process.env.CORRA_CALLBACK_URL ?? 'http://host.docker.internal:8787/callbacks/sep24',
};
const render = (tmpl: string) =>
  readFileSync(join(here, 'config', tmpl), 'utf8').replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`unknown template variable ${k} in ${tmpl}`);
    return vars[k];
  });

writeFileSync(join(out, 'assets.yaml'), render('assets.yaml.tmpl'));
writeFileSync(join(out, 'clients.yaml'), render('clients.yaml.tmpl'));
writeFileSync(join(out, 'stellar.toml'), render('stellar.toml.tmpl'));
writeFileSync(secretsPath, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
writeFileSync(
  join(out, 'business.env'),
  [
    `SEP24_INTERACTIVE_URL_JWT_SECRET=${secrets.SECRET_SEP24_INTERACTIVE_URL_JWT_SECRET}`,
    `ANCHOR_DISTRIBUTION_SECRET=${testnet.ANCHOR_DISTRIBUTION_SECRET}`,
    `ASSET_CODE=TESTMXN`,
    `ASSET_ISSUER=${TESTNET.corridorIssuer}`,
    `PLATFORM_API_URL=http://platform:8085`,
    '',
  ].join('\n'),
);

console.log(`anchor config written to ${out}\n  SEP-10 SIGNING_KEY ${sep10Key}\n  TESTMXN issuer     ${TESTNET.corridorIssuer}\n  distribution       ${TESTNET.anchorDistribution}`);
