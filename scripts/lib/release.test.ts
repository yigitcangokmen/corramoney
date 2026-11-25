import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as S from '@stellar/stellar-sdk';
import { formatRules, releaseRules, type ReleaseFiles } from './release';
import { checkKeyFiles } from './keys';

const kp = () => S.Keypair.random();
const keys = { usdcIssuer: kp(), corridorIssuer: kp(), anchorDistribution: kp(), marketMaker: kp(), feeSponsor: kp(), clientDomainSigner: kp() };
const channels = Array.from({ length: 5 }, kp);
const admin = kp();
const sac = 'C' + 'A'.repeat(55);

/** A render as deploy.sh --render-only makes it, with the committed deploy files of this repo. */
function good(): ReleaseFiles {
  const testnetTs = `export const TESTNET = {
${Object.entries(keys).map(([k, v]) => `  ${k}: '${v.publicKey()}',`).join('\n')}
  sac: {
    "TESTMXN": "${sac}"
  },
} as const;
`;
  return {
    orchestratorEnv: [
      'PORT=8787', 'DATABASE_URL=postgres://corra:corra@corra-db:5432/corra', `FEE_SPONSOR_SECRET=${keys.feeSponsor.secret()}`,
      `CLIENT_DOMAIN_SIGNING_SECRET=${keys.clientDomainSigner.secret()}`, `CHANNEL_SECRETS=${channels.map((c) => c.secret()).join(',')}`,
      'ANCHOR_HOME_DOMAIN=http://platform:8080', 'CORRA_CLIENT_DOMAIN=api.corra.money', 'CORS_ORIGINS=https://app.corra.money', '',
    ].join('\n'),
    envTestnet: [
      `USDC_ISSUER_SECRET=${keys.usdcIssuer.secret()}`, `CORRIDOR_ISSUER_SECRET=${keys.corridorIssuer.secret()}`,
      `ANCHOR_DISTRIBUTION_SECRET=${keys.anchorDistribution.secret()}`, `MARKET_MAKER_SECRET=${keys.marketMaker.secret()}`,
      `FEE_SPONSOR_SECRET=${keys.feeSponsor.secret()}`, `CLIENT_DOMAIN_SIGNING_SECRET=${keys.clientDomainSigner.secret()}`,
      `CHANNEL_SECRETS=${channels.map((c) => c.secret()).join(',')}`, `POOL_ADMIN_SECRET=${admin.secret()}`, '',
    ].join('\n'),
    testnetTs,
    channelsTs: `export const TESTNET_CHANNELS: readonly string[] = [\n${channels.map((c) => `  '${c.publicKey()}',`).join('\n')}\n];\n`,
    blendTs: `export const TESTNET_BLEND: BlendIds | null = {\n  pool: 'C${'B'.repeat(55)}',\n  asset: '${sac}',\n  admin: '${admin.publicKey()}',\n};\n`,
    assetsYaml: `items:
  - id: stellar:TESTMXN:${keys.corridorIssuer.publicKey()}
    distribution_account: ${keys.anchorDistribution.publicKey()}
    sep24:
      enabled: true
      deposit:
        enabled: true
      withdraw:
        enabled: false
    sep31:
      enabled: false
  - id: stellar:TESTPHP:${keys.corridorIssuer.publicKey()}
    distribution_account: ${keys.anchorDistribution.publicKey()}
    sep24:
      enabled: true
      deposit:
        enabled: false
      withdraw:
        enabled: true
    sep31:
      enabled: false
`,
    businessEnv: 'SEP24_INTERACTIVE_URL_JWT_SECRET=aaaa\nSEP24_MORE_INFO_URL_JWT_SECRET=bbbb\nWITHDRAW_ASSET_CODE=TESTPHP\n',
    stellarToml: `ACCOUNTS = ["${keys.anchorDistribution.publicKey()}"]\n[[CURRENCIES]]\ncode = "TESTMXN"\n[[CURRENCIES]]\ncode = "TESTPHP"\n`,
    caddyfile: readFileSync('deploy/Caddyfile', 'utf8'),
    compose: readFileSync('deploy/docker-compose.yml', 'utf8'),
    webPackage: readFileSync('apps/web/package.json', 'utf8'),
    deploySh: readFileSync('deploy/deploy.sh', 'utf8'),
  };
}

const failing = (f: ReleaseFiles) => releaseRules(f).filter((r) => !r.ok).map((r) => r.id);

test('RC1 a good render passes every rule', () => {
  assert.deepEqual(failing(good()), []);
  assert.equal(releaseRules(good()).length, 16);
});

test('RC2 one mutated input per rule fails exactly that rule', () => {
  const g = good();
  const other = kp();
  const mutations: [string, Partial<ReleaseFiles>][] = [
    ['R-ENV-1', { orchestratorEnv: g.orchestratorEnv + 'RPC_URL=https://soroban-testnet.stellar.org\n' }],
    ['R-ENV-2', { orchestratorEnv: g.orchestratorEnv.replace('CORS_ORIGINS=https://app.corra.money', `CORS_ORIGINS=https://app.corra.money,${keys.marketMaker.secret()}`) }],
    ['R-ENV-3', { orchestratorEnv: g.orchestratorEnv.replace('http://platform:8080', 'http://localhost:8080') }],
    ['R-KEY-1', { orchestratorEnv: g.orchestratorEnv.replace(keys.feeSponsor.secret(), other.secret()) }],
    ['R-KEY-2', { orchestratorEnv: g.orchestratorEnv.replace(channels.map((c) => c.secret()).join(','), [...channels].reverse().map((c) => c.secret()).join(',')) }],
    ['R-KEY-3', { orchestratorEnv: g.orchestratorEnv.replace(keys.clientDomainSigner.secret(), other.secret()) }],
    ['R-ANC-1', { assetsYaml: g.assetsYaml.replace(/withdraw:\n        enabled: true/, 'withdraw:\n        enabled: false') }],
    ['R-ANC-2', { businessEnv: g.businessEnv.replace('bbbb', 'aaaa') }],
    ['R-ANC-3', { stellarToml: g.stellarToml.replace('code = "TESTPHP"', 'code = "TESTBRL"') }],
    ['R-CAD-1', { caddyfile: g.caddyfile.replace(' /sep24/withdraw-confirm*', '') }],
    ['R-CMP-1', { compose: g.compose.replace('  goatcounter:\n    image: arp242/goatcounter:2.7.0\n', '  goatcounter:\n    image: arp242/goatcounter:2.7.0\n    ports:\n      - "8080:8080"\n') }],
    ['R-CMP-2', { compose: g.compose.replace('    stop_grace_period: 40s\n', '') }],
    ['R-DEP-1', { deploySh: g.deploySh.replace('goatcounter db show site -find=stats.corra.money', 'goatcounter version') }],
    ['R-DEP-2', { deploySh: g.deploySh.replace(' --exclude /backups', '') }],
    ['R-WEB-1', { webPackage: g.webPackage.replace(' VITE_STATS_URL=https://stats.corra.money', '') }],
    ['R-GEN-1', { blendTs: 'export const TESTNET_BLEND: BlendIds | null = null;\n' }],
  ];
  for (const [rule, patch] of mutations) {
    const f = { ...g, ...patch };
    assert.notDeepEqual(f, g, `${rule}: the mutation changed nothing`);
    assert.deepEqual(failing(f), [rule], rule);
  }
});

test('RC3 no output line holds secret text, even when rules fail', () => {
  const g = good();
  const secrets = [...Object.values(keys), ...channels, admin].map((k) => k.secret());
  const bad = { ...g, orchestratorEnv: g.orchestratorEnv.replace(keys.feeSponsor.secret(), keys.marketMaker.secret()) };
  for (const files of [g, bad]) {
    const lines = formatRules(releaseRules(files)).join('\n');
    for (const s of secrets) assert.ok(!lines.includes(s));
    assert.doesNotMatch(lines, /S[A-Z2-7]{55}/);
  }
  const k = checkKeyFiles({ env: g.envTestnet, testnetTs: g.testnetTs, channelsTs: g.channelsTs, blendTs: g.blendTs });
  assert.deepEqual([k.base, k.channels, k.poolAdmin], ['ok', 'ok', 'ok']);
  assert.doesNotMatch(JSON.stringify(k), /S[A-Z2-7]{55}/);
});

test('RC4 deploy.sh refuses any argument but --render-only before it reads a key or reaches the host (S3-2)', () => {
  // A copy in an empty folder: no .env.testnet, so a parse that lets the argument through stops at
  // ".env.testnet missing" (exit 1) instead of the usage error (exit 2). Nothing here can deploy.
  const root = mkdtempSync(join(tmpdir(), 'corra-deploy-'));
  mkdirSync(join(root, 'deploy'));
  copyFileSync('deploy/deploy.sh', join(root, 'deploy/deploy.sh'));
  const run = (...args: string[]) => spawnSync('bash', [join(root, 'deploy/deploy.sh'), ...args], { encoding: 'utf8', env: { ...process.env, DEPLOY_HOST: 'nobody@127.0.0.1' } });
  try {
    for (const args of [['--dry-run'], ['--render'], ['render-only'], ['--render-only', '--extra'], ['']]) {
      const r = run(...args);
      assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
      assert.match(r.stderr, /usage: deploy\/deploy.sh \[--render-only\]/);
    }
    // The accepted forms pass the parse and stop at the first file check.
    for (const args of [[], ['--render-only']]) assert.equal(run(...args).status, 1, JSON.stringify(args));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
