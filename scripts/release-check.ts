/**
 * Offline release rules over what `deploy/deploy.sh --render-only` rendered into deploy/.secrets and
 * the committed deploy files (scripts/lib/release.ts), plus the secret scan (`pnpm secret-scan`) over
 * every file git would ship. Prints only PASS/FAIL per rule, never a value; exit 1 on any FAIL. Deploys nothing.
 *
 *   deploy/deploy.sh --render-only && pnpm release-check
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { formatRules, releaseRules, type ReleaseFiles } from './lib/release';
import { seedHits } from './lib/secret-scan';

const FILES: Record<keyof ReleaseFiles, string> = {
  orchestratorEnv: 'deploy/.secrets/orchestrator.env',
  envTestnet: '.env.testnet',
  testnetTs: 'packages/shared/src/testnet.ts',
  channelsTs: 'packages/shared/src/testnet-channels.ts',
  blendTs: 'packages/shared/src/testnet-blend.ts',
  assetsYaml: 'deploy/.secrets/anchor/assets.yaml',
  businessEnv: 'deploy/.secrets/anchor/business.env',
  stellarToml: 'deploy/.secrets/anchor/stellar.toml',
  caddyfile: 'deploy/Caddyfile',
  compose: 'deploy/docker-compose.yml',
  webPackage: 'apps/web/package.json',
  deploySh: 'deploy/deploy.sh',
};

const missing = Object.values(FILES).filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`release-check: missing ${missing.join(', ')} (run deploy/deploy.sh --render-only first)`);
  process.exit(1);
}
const files = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [k, readFileSync(p, 'utf8')])) as ReleaseFiles;
const shipped = execFileSync('git', ['ls-files', '-cmo', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const rules = [...releaseRules(files),
  { id: 'R-SEC-1', what: 'no seed-shaped string in any file git would ship (pnpm secret-scan)', ok: seedHits(shipped).length === 0 }];
for (const line of formatRules(rules)) console.log(line);
const failed = rules.filter((r) => !r.ok).length;
console.log(`\nrelease-check: ${rules.length - failed} PASS, ${failed} FAIL`);
if (failed) process.exit(1);
