/**
 * The release rules `pnpm release-check` applies to what `deploy/deploy.sh --render-only` rendered,
 * plus the committed deploy files. Pure over file texts: each rule is PASS or FAIL, and nothing a
 * rule reads (a secret included) is ever part of its result.
 */
import { channelsOf, envOf, publicOf, testnetKeysOf } from './keys';

export type ReleaseFiles = {
  /** deploy/.secrets/orchestrator.env */
  orchestratorEnv: string;
  /** .env.testnet: the secrets that must never reach the orchestrator. */
  envTestnet: string;
  testnetTs: string;
  channelsTs: string;
  blendTs: string;
  /** deploy/.secrets/anchor/{assets.yaml,business.env,stellar.toml} */
  assetsYaml: string;
  businessEnv: string;
  stellarToml: string;
  caddyfile: string;
  /** deploy/docker-compose.yml */
  compose: string;
  /** apps/web/package.json */
  webPackage: string;
  /** deploy/deploy.sh */
  deploySh: string;
};

export type RuleResult = { id: string; what: string; ok: boolean };

export const ORCHESTRATOR_ENV_KEYS = ['PORT', 'DATABASE_URL', 'FEE_SPONSOR_SECRET', 'CLIENT_DOMAIN_SIGNING_SECRET', 'CHANNEL_SECRETS',
  'ANCHOR_HOME_DOMAIN', 'CORRA_CLIENT_DOMAIN', 'CORS_ORIGINS'];
/** Secrets of .env.testnet that stay with the scripts and the anchor, never in the orchestrator. */
const SCRIPT_SECRETS = ['USDC_ISSUER_SECRET', 'CORRIDOR_ISSUER_SECRET', 'MARKET_MAKER_SECRET', 'ANCHOR_DISTRIBUTION_SECRET', 'POOL_ADMIN_SECRET'];

/** SEP-24 deposit and withdraw switches of one asset in an Anchor Platform assets.yaml (null when the asset is absent). */
export function sep24Of(yaml: string, code: string): { deposit: boolean; withdraw: boolean; distribution: string | null } | null {
  const block = yaml.split(/\n  - id: /).find((b) => b.startsWith(`stellar:${code}:`));
  if (!block) return null;
  const sep24 = block.slice(block.indexOf('sep24:'));
  const flag = (name: string) => new RegExp(`\\b${name}:\\s*\\n\\s*enabled:\\s*true`).test(sep24.split(/\n    sep3[18]:/)[0]);
  return { deposit: flag('deposit'), withdraw: flag('withdraw'), distribution: /distribution_account:\s*(G[A-Z2-7]{55})/.exec(block)?.[1] ?? null };
}

/** Each compose service's own text, by name. */
function composeServices(compose: string): Record<string, string> {
  const start = compose.indexOf('\nservices:\n');
  if (start < 0) return {};
  const rest = compose.slice(start + '\nservices:\n'.length);
  // The services block ends at the next top-level key.
  const top = rest.search(/^[a-z]/m);
  const block = top < 0 ? rest : rest.slice(0, top);
  const out: Record<string, string> = {};
  for (const part of block.split(/^(?=  [a-z][\w-]*:\s*$)/m)) {
    const m = /^  ([a-z][\w-]*):/.exec(part);
    if (m) out[m[1]] = part;
  }
  return out;
}

export function releaseRules(f: ReleaseFiles): RuleResult[] {
  const env = envOf(f.orchestratorEnv);
  const testnet = envOf(f.envTestnet);
  const pub = testnetKeysOf(f.testnetTs);
  const php = sep24Of(f.assetsYaml, 'TESTPHP');
  const mxn = sep24Of(f.assetsYaml, 'TESTMXN');
  const business = envOf(f.businessEnv);
  const services = composeServices(f.compose);
  const topVolumes = f.compose.slice(f.compose.lastIndexOf('\nvolumes:'));
  const business24 = /@business\s+path\s+([^\n]*)/.exec(f.caddyfile)?.[1] ?? '';
  const buildProd = /"build:prod":\s*"([^"]*)"/.exec(f.webPackage)?.[1] ?? '';
  const blendAsset = /\basset: '(C[A-Z2-7]{55})'/.exec(f.blendTs)?.[1];
  const mxnSac = /"TESTMXN":\s*"(C[A-Z2-7]{55})"/.exec(f.testnetTs)?.[1];
  const channels = channelsOf(f.channelsTs);
  const channelPks = (env.CHANNEL_SECRETS ?? '').split(',').filter(Boolean).map((s) => publicOf(s.trim()));
  const values = Object.values(env);

  return [
    { id: 'R-ENV-1', what: `orchestrator.env holds exactly ${ORCHESTRATOR_ENV_KEYS.join(', ')}`,
      ok: Object.keys(env).sort().join(',') === [...ORCHESTRATOR_ENV_KEYS].sort().join(',') },
    { id: 'R-ENV-2', what: 'no local setup limits, pool admin, issuer, market-maker or distribution secret in orchestrator.env',
      ok: !('CORRA_LOCAL_SETUP_LIMITS' in env) && !SCRIPT_SECRETS.some((k) => k in env || (!!testnet[k] && values.some((v) => v.includes(testnet[k])))) },
    { id: 'R-ENV-3', what: 'ANCHOR_HOME_DOMAIN is not a localhost anchor', ok: !!env.ANCHOR_HOME_DOMAIN && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(env.ANCHOR_HOME_DOMAIN) },
    { id: 'R-KEY-1', what: 'the sponsor secret is TESTNET.feeSponsor', ok: !!pub.feeSponsor && publicOf(env.FEE_SPONSOR_SECRET) === pub.feeSponsor },
    { id: 'R-KEY-2', what: 'CHANNEL_SECRETS are TESTNET_CHANNELS, in order',
      ok: channels.length === 5 && channelPks.length === channels.length && channelPks.every((pk, i) => pk === channels[i]) },
    { id: 'R-KEY-3', what: 'the client_domain secret is TESTNET.clientDomainSigner',
      ok: !!pub.clientDomainSigner && publicOf(env.CLIENT_DOMAIN_SIGNING_SECRET) === pub.clientDomainSigner },
    { id: 'R-ANC-1', what: 'assets.yaml: TESTPHP withdraw on and deposit off, TESTMXN deposit only',
      ok: !!php && php.withdraw && !php.deposit && !!mxn && mxn.deposit && !mxn.withdraw },
    { id: 'R-ANC-2', what: 'business env: WITHDRAW_ASSET_CODE=TESTPHP, the more_info secret differs from the interactive one',
      ok: business.WITHDRAW_ASSET_CODE === 'TESTPHP' && !!business.SEP24_MORE_INFO_URL_JWT_SECRET && !!business.SEP24_INTERACTIVE_URL_JWT_SECRET
        && business.SEP24_MORE_INFO_URL_JWT_SECRET !== business.SEP24_INTERACTIVE_URL_JWT_SECRET },
    { id: 'R-ANC-3', what: 'stellar.toml lists TESTPHP and the distribution account',
      ok: /code\s*=\s*"TESTPHP"/.test(f.stellarToml) && !!pub.anchorDistribution
        && new RegExp(`ACCOUNTS\\s*=\\s*\\[[^\\]]*"${pub.anchorDistribution}"`).test(f.stellarToml) },
    { id: 'R-CAD-1', what: 'Caddyfile serves stats.corra.money and routes /sep24/withdraw-confirm* to the business server',
      ok: /^stats\.corra\.money\s*\{/m.test(f.caddyfile) && business24.split(/\s+/).includes('/sep24/withdraw-confirm*') },
    { id: 'R-CMP-1', what: 'only caddy publishes ports; goatcounter keeps its data in a named volume',
      ok: Object.entries(services).every(([name, text]) => (name === 'caddy') === /\n\s+ports:/.test(text))
        && /goatcounter-data:\/home\/goatcounter\/goatcounter-data/.test(services.goatcounter ?? '') && /\n  goatcounter-data:/.test(topVolumes) },
    { id: 'R-CMP-2', what: 'the orchestrator runs under an init and gets a stop_grace_period of at least 31 s (its 15 s + 15 s drain)',
      ok: /\n\s+init: true\n/.test(services.orchestrator ?? '')
        && Number(/\n\s+stop_grace_period: (\d+)s\n/.exec(services.orchestrator ?? '')?.[1] ?? 0) >= 31 },
    { id: 'R-DEP-1', what: 'deploy.sh starts nothing until GoatCounter has the stats.corra.money site (no open first-site form)',
      ok: (() => {
        const guard = f.deploySh.indexOf('goatcounter db show site -find=stats.corra.money');
        const up = f.deploySh.indexOf('docker-compose.yml up');
        return guard > 0 && up > guard;
      })() },
    { id: 'R-DEP-2', what: "deploy.sh's rsync --delete of the source excludes /backups (a backup under /opt/corra survives a deploy)",
      ok: /rsync -az --delete [^\n]*(?:\\\n[^\n]*)*--exclude \/backups[\s\\]/.test(f.deploySh) },
    { id: 'R-WEB-1', what: 'build:prod counts at https://stats.corra.money', ok: /(^|\s)VITE_STATS_URL=https:\/\/stats\.corra\.money(\s|$)/.test(buildProd) },
    { id: 'R-GEN-1', what: 'TESTNET_BLEND names a pool whose asset is the TESTMXN SAC', ok: !!blendAsset && blendAsset === mxnSac },
  ];
}

/** `PASS <rule>: <what>` / `FAIL ...`: rule ids and fixed descriptions only, never a value read from a file. */
export const formatRules = (rules: RuleResult[]) => rules.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.id}: ${r.what}`);
