/**
 * CI job `no-server-side-signing`. Reads every server-reachable module and fails on:
 *   1. a key being loaded, derived or used to sign outside the two allowed modules
 *   2. a seed-shaped string (S + 55 base32 chars) anywhere in server code
 *   3. the fee-and-sponsor secret flowing anywhere except into createSponsor()
 *   4. the allowed modules signing more call sites than their documented scope
 * It asserts a scope, not an absolute: CAP-15 fee-bumps, CAP-33 sponsorship and the SEP-10
 * client_domain co-signature make a bounded set of server signatures unavoidable.
 * Their runtime refusals are covered by the unit tests this job also runs.
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
// Directories can be passed as arguments, e.g. to prove the job fails on a fixture.
const SCOPE = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['services/orchestrator/src', 'packages/stellar/src', 'packages/settlement-saga/src', 'packages/shared/src'];

/** module -> how many signing call sites it may contain, and why. */
const ALLOWED_SIGNERS: Record<string, { calls: number; why: string }> = {
  'packages/stellar/src/sponsor.ts': { calls: 2, why: 'fee-bump envelope + verified sponsorship sandwich' },
  'services/orchestrator/src/client-domain.ts': { calls: 1, why: 'SEP-10 client_domain co-signature on a sequence-0 challenge' },
};
const KEY_LOADERS = new Set(['fromSecret', 'fromRawEd25519Seed', 'random', 'master']);
const SIGNERS = new Set(['sign', 'signDecorated', 'signPayloadDecorated', 'signHashX', 'signTransaction', 'signAuthEntry']);
const SEED = /S[A-Z2-7]{55}/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const violations: string[] = [];
const scanned: string[] = [];
const signCalls: Record<string, number> = {};
const sponsorSecretUses: string[] = [];

for (const dir of SCOPE) {
  for (const abs of files(resolve(ROOT, dir))) {
    const rel = relative(ROOT, abs);
    scanned.push(rel);
    const src = ts.createSourceFile(rel, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

    const visit = (n: ts.Node) => {
      if (ts.isStringLiteralLike(n) && SEED.test(n.text)) violations.push(`${at(n)} seed-shaped string literal`);

      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const name = n.expression.name.text;
        const target = n.expression.expression.getText(src);
        if (KEY_LOADERS.has(name) && /Keypair$/.test(target)) {
          if (!ALLOWED_SIGNERS[rel]) violations.push(`${at(n)} loads a key: ${target}.${name}()`);
        }
        if (SIGNERS.has(name)) {
          if (!ALLOWED_SIGNERS[rel]) violations.push(`${at(n)} signs outside the allowed modules: .${name}()`);
          else signCalls[rel] = (signCalls[rel] ?? 0) + 1;
        }
      }

      if (ts.isIdentifier(n) && /^(feeSponsorSecret|FEE_SPONSOR_SECRET)$/.test(n.text)) sponsorSecretUses.push(at(n));
      ts.forEachChild(n, visit);
    };
    visit(src);

    const text = src.getFullText();
    if (/FEE_SPONSOR_SECRET|feeSponsorSecret/.test(text) && !/config\.ts$|orchestrator\/src\/index\.ts$/.test(rel)) {
      violations.push(`${rel} touches the fee-sponsor secret (only config.ts and index.ts may)`);
    }
    if (/orchestrator\/src\/index\.ts$/.test(rel)) {
      const uses = text.match(/cfg\.feeSponsorSecret/g) ?? [];
      const passedToSponsor = /createSponsor\(\s*cfg\.feeSponsorSecret/.test(text);
      if (uses.length !== 1 || !passedToSponsor) {
        violations.push(`${rel} must pass cfg.feeSponsorSecret to createSponsor() and nowhere else (found ${uses.length} uses)`);
      }
    }
  }
}

// Only for the real scope: a fixture run must fail on the fixture's own violations alone.
if (!process.argv.slice(2).length) {
  for (const [mod, rule] of Object.entries(ALLOWED_SIGNERS)) {
    const found = signCalls[mod] ?? 0;
    if (found !== rule.calls) violations.push(`${mod} has ${found} signing call sites, its documented scope is ${rule.calls}`);
  }
}

console.log('no-server-side-signing');
console.log(`  scope: ${SCOPE.join(', ')} (${scanned.length} modules, tests excluded)`);
console.log('  allowed server signatures:');
for (const [mod, rule] of Object.entries(ALLOWED_SIGNERS)) console.log(`    ${mod}: ${rule.calls} call site(s), ${rule.why}`);
console.log(`  fee-sponsor secret references: ${sponsorSecretUses.join(', ') || 'none'}`);

if (violations.length) {
  console.error(`\nFAILED: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('\nPASSED: no user key is loaded, derived or signed with anywhere in server code.');
