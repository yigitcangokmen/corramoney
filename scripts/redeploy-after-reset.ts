/**
 * Rebuilds Corra's testnet side after an SDF testnet reset (next: 2026-12-16 17:00 UTC) with the
 * same team keys, so every address and SAC id the SOW names stays; only the Blend pool gets new ids.
 * Each step has a read-only check; --plan (the default) prints done | todo | blocked, --run runs
 * only the steps not done and proves afterwards what it did not touch. Stellar TESTNET only.
 *
 *   pnpm redeploy-after-reset                         # plan: read only
 *   pnpm redeploy-after-reset --run [--wait-blend MIN]
 *
 * Exit 0 all done; 3 all done except the steps waiting for Blend's factory; 4 (plan only) steps to do,
 * so the testnet is not rebuilt; 2 a step or a check failed (a check that throws never runs its step); 1 preflight (key files that do not match, not testnet). Never runs deploy.sh, publish-app, git or
 * SQL: production is the builder's step (docs/release-checklist.md), printed at the end.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as S from '@stellar/stellar-sdk';
import { TESTNET, type BlendIds } from '../packages/shared/src';
import { channelsOf, checkKeyFiles, envOf, publicOf, testnetKeysOf } from './lib/keys';
import { blendUtils, minDaysLeft, ORACLE_WASM, sharedKeys, verifyPool } from './lib/pool';
import { sep24Of } from './lib/release';
import { blendState, childPhase, exitCode, poolStatus, runs, settle, waitMinutes, type Status } from './lib/reset';
import { planSeed, ROLES, type Role } from './lib/seed-plan';
import { accountOrNull, channelState, corridorPaths, HORIZON_URL, missingDestTrust, readChainState, rpc, sequences } from './lib/testnet-state';

const args = process.argv.slice(2);
const RUN = args.includes('--run');
const WAIT_MIN = (() => {
  try {
    return waitMinutes(args);
  } catch (e) {
    console.error(`redeploy-after-reset: ${(e as Error).message}`);
    process.exit(1);
  }
})();
const TTL_DAYS = 21;
const ENV = '.env.testnet';
const GENERATED = ['.env.testnet', 'packages/shared/src/testnet.ts', 'packages/shared/src/testnet-channels.ts', 'packages/shared/src/testnet-blend.ts',
  'infra/anchor/generated/assets.yaml', 'infra/anchor/generated/stellar.toml', 'infra/anchor/generated/clients.yaml'];

type Step = { id: string; check: () => Promise<Status>; run?: string[][]; needs?: string[] };

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const done = (why: string): Status => ({ state: 'done', why });
const todo = (why: string): Status => ({ state: 'todo', why });
const blocked = (why: string): Status => ({ state: 'blocked', why });
/** The contract instance of `id` is on chain (a reset deletes it). A failed read throws. */
const instanceLive = async (id: string) => (await rpc.getLedgerEntries(new S.Contract(id).getFootprint())).entries.length > 0;

/** The generated files as they are now (a step may have rewritten them since this process started). */
const keyFiles = () => ({ env: read(ENV), testnetTs: read('packages/shared/src/testnet.ts'),
  channelsTs: read('packages/shared/src/testnet-channels.ts'), blendTs: read('packages/shared/src/testnet-blend.ts') });

/** TESTNET_BLEND as packages/shared/src/testnet-blend.ts holds it now (deploy-pool rewrites it mid-run). */
function blendNow(): BlendIds | null {
  const text = read('packages/shared/src/testnet-blend.ts');
  if (/TESTNET_BLEND: BlendIds \| null = null;/.test(text)) return null;
  const f = Object.fromEntries([...text.matchAll(/^\s+(\w+): '([^']*)',?$/gm)].map((m) => [m[1], m[2]]));
  return f.pool ? (f as unknown as BlendIds) : null;
}

const roleKeys = (): Record<Role, string> => {
  const pub = testnetKeysOf(read('packages/shared/src/testnet.ts'));
  return Object.fromEntries(ROLES.map((r) => [r, pub[r]])) as Record<Role, string>;
};

async function blendFactory(): Promise<Status> {
  const { ids, hashes } = await blendUtils();
  if (!ids.poolFactoryV2 || !ids.backstopV2) return blocked('blend-utils lists no poolFactoryV2/backstopV2');
  // deploy-pool deploys Blend's oraclemock WASM too: the step is done only when all three are on chain.
  const oracleWasm = S.xdr.LedgerKey.contractCode(new S.xdr.LedgerKeyContractCode({ hash: Buffer.from(hashes.oraclemock ?? ORACLE_WASM, 'hex') }));
  const keys = { factory: new S.Contract(ids.poolFactoryV2).getFootprint(), backstop: new S.Contract(ids.backstopV2).getFootprint(), oracleWasm };
  const res = await rpc.getLedgerEntries(...Object.values(keys));
  const found = new Set(res.entries.map((e) => e.key.toXDR('base64')));
  const st = blendState({ factory: found.has(keys.factory.toXDR('base64')), backstop: found.has(keys.backstop.toXDR('base64')),
    oracleWasm: found.has(oracleWasm.toXDR('base64')) });
  return st.state === 'done' ? done(`factory ${ids.poolFactoryV2}, backstop and oracle WASM live`) : blocked(st.why);
}

const STEPS: Step[] = [
  {
    id: 'seed',
    check: async () => {
      const plan = planSeed(await readChainState(roleKeys()), roleKeys());
      if (plan.length) return todo(`${plan.length} action(s): ${[...new Set(plan.map((a) => a.kind))].join(', ')}`);
      const dead = (await corridorPaths(TESTNET.corridorIssuer)).filter((p) => !p.sourceAmount).map((p) => p.code);
      return dead.length ? todo(`no path to ${dead.join(', ')}`) : done('accounts, trustlines, balances, 12 offers, 7 SACs; the 5 paths resolve');
    },
    run: [['seed-testnet', '--reuse-keys']],
  },
  {
    id: 'demo-recipient',
    needs: ['seed'],
    check: async () => {
      const r = testnetKeysOf(read('packages/shared/src/testnet.ts')).demoRecipient;
      if (!r) return todo('none in testnet.ts');
      const missing = await missingDestTrust(r, TESTNET.corridorIssuer);
      return missing.length ? todo(`${r.slice(0, 8)}... lacks ${missing.join(', ')}`) : done(`${r} trusts the 5 destination assets`);
    },
    run: [['demo-recipient', '--if-missing']],
  },
  {
    id: 'channels',
    check: async () => {
      const k = checkKeyFiles(keyFiles());
      if (k.channels !== 'ok') return todo(k.channels === 'todo' ? 'no CHANNEL_SECRETS or no testnet-channels.ts' : 'keys do not match');
      for (const pk of channelsOf(read('packages/shared/src/testnet-channels.ts'))) {
        const c = await channelState(pk);
        if (!c.exists) return todo(`${pk.slice(0, 8)}... missing`);
        if (c.xlm < 100 || !c.ownSignerOnly) return todo(`${pk.slice(0, 8)}... ${c.xlm} XLM${c.ownSignerOnly ? '' : ', reshaped'}`);
      }
      return done('5 channels, >= 100 XLM, own signer only');
    },
    run: [['create-channels']],
  },
  {
    id: 'anchor-config',
    check: async () => {
      const yaml = read('infra/anchor/generated/assets.yaml');
      const toml = read('infra/anchor/generated/stellar.toml');
      if (!yaml || !toml || !existsSync('infra/anchor/generated/clients.yaml')) return todo('infra/anchor/generated incomplete');
      const php = sep24Of(yaml, 'TESTPHP');
      const ok = php?.withdraw && php.distribution === TESTNET.anchorDistribution && toml.includes(`"${TESTNET.anchorDistribution}"`)
        && yaml.includes(`stellar:TESTMXN:${TESTNET.corridorIssuer}`);
      return ok ? done('names the distribution account; TESTPHP withdraw on') : todo('stale for these accounts');
    },
    run: [['exec', 'tsx', 'infra/anchor/setup.ts']],
  },
  { id: 'blend', check: blendFactory },
  {
    id: 'pool',
    needs: ['seed', 'blend'],
    // todo only with no pool recorded or its instance gone; a live pool that does not verify fails (S5-1, J-u6-9).
    check: async () => {
      const b = blendNow();
      return poolStatus(b?.pool ?? null, { instanceLive: () => instanceLive(b!.pool), verify: () => verifyPool(b!) });
    },
    run: [['deploy-pool'], ['pool-check', '--verify-only']],
  },
  {
    id: 'pool-ttl',
    needs: ['pool'],
    check: async () => {
      const b = blendNow();
      if (!b) return todo('no pool');
      if (!(await instanceLive(b.pool))) return todo(`the recorded pool ${b.pool} has no contract instance on chain`);
      const days = await minDaysLeft(await sharedKeys(b.pool, b.oracle, b.asset));
      return days >= TTL_DAYS ? done(`${days.toFixed(1)} days left`) : todo(`${days.toFixed(1)} days left (< ${TTL_DAYS}; maintenance)`);
    },
    run: [['pool-ttl']],
  },
];

/** Preflight: the key files agree, Horizon is testnet. Returns problems (exit 1) and notes. */
async function preflight() {
  const problems: string[] = [];
  const notes: string[] = [];
  const k = checkKeyFiles(keyFiles());
  if (k.base !== 'ok') problems.push(...k.problems.filter((p) => !/CHANNEL|POOL_ADMIN/.test(p)));
  if (k.channels === 'mismatch') problems.push('CHANNEL_SECRETS do not match testnet-channels.ts');
  if (k.poolAdmin === 'mismatch') problems.push('POOL_ADMIN_SECRET does not match the pool admin in testnet-blend.ts');
  if (k.channels === 'todo') notes.push('no CHANNEL_SECRETS yet: create-channels will make them');
  if (k.poolAdmin === 'todo') notes.push('no pool admin pair yet: deploy-pool will make or reuse one');
  const root = await (await fetch(`${HORIZON_URL}/`)).json();
  if (root.network_passphrase !== TESTNET.networkPassphrase) problems.push(`Horizon is not testnet (${root.network_passphrase})`);
  let reset = false;
  if (!(await accountOrNull(TESTNET.corridorIssuer))) {
    reset = true;
    notes.push('reset detected: the corridor issuer does not exist on chain');
  }
  const b = blendNow();
  if (b && !(await instanceLive(b.pool))) {
    reset = true;
    notes.push(`reset detected: the recorded pool ${b.pool} has no contract instance on chain`);
  }
  return { problems, notes, reset };
}

/** The team accounts whose sequence proves what was submitted: issuers, market maker, distribution, sponsor, channels, pool admin. */
function teamAccounts(): string[] {
  const env = envOf(read(ENV));
  const admin = publicOf(env.POOL_ADMIN_SECRET);
  return [...ROLES.map((r) => roleKeys()[r]), ...channelsOf(read('packages/shared/src/testnet-channels.ts')), ...(admin ? [admin] : [])];
}

const sha1 = (p: string) => (existsSync(p) ? createHash('sha1').update(readFileSync(p)).digest('hex') : 'absent');

/** The environment the run steps get: after a reset, evidence goes to post-reset (C5-2). */
let childEnv: NodeJS.ProcessEnv = process.env;

function pnpm(argv: string[]) {
  console.log(`\n$ pnpm ${argv.join(' ')}`);
  return spawnSync('pnpm', argv, { stdio: 'inherit', env: childEnv }).status === 0;
}

function productionBlock() {
  const md = read('docs/release-checklist.md');
  const start = md.indexOf('## 9.');
  const end = md.indexOf('\n## ', start + 1);
  console.log('\nProduction (the builder approves; this script never deploys):');
  console.log(start < 0 ? '  see docs/release-checklist.md' : md.slice(start, end < 0 ? undefined : end).trim());
}

async function main() {
  console.log(`redeploy-after-reset ${RUN ? '--run' : '--plan'} (Stellar testnet)`);
  const pre = await preflight();
  for (const n of pre.notes) console.log(`  note: ${n}`);
  if (pre.problems.length) {
    for (const p of pre.problems) console.error(`  preflight: ${p}`);
    process.exit(1);
  }

  const status = new Map<string, Status>();
  const checkAll = async () => {
    for (const s of STEPS) {
      status.set(s.id, await settle(s.check));
      // A step that needs a blocked one (Blend's factory) is blocked too; a failed check stays failed.
      if ((s.needs ?? []).some((n) => status.get(n)?.state === 'blocked') && status.get(s.id)!.state === 'todo') status.set(s.id, blocked('waits for Blend'));
    }
  };
  const table = () => {
    for (const s of STEPS) console.log(`  ${s.id.padEnd(15)} ${status.get(s.id)!.state.padEnd(8)} ${status.get(s.id)!.why}`);
  };
  await checkAll();
  console.log('\nplan:');
  table();

  if (!RUN) {
    process.exit(exitCode([...status.values()].map((v) => v.state), false));
  }

  try {
    const phase = childPhase(process.env.EVIDENCE_PHASE, pre.reset);
    if (phase) {
      childEnv = { ...process.env, EVIDENCE_PHASE: phase };
      console.log(`\nrun steps write evidence with EVIDENCE_PHASE=${phase}`);
    }
  } catch (e) {
    console.error(`  preflight: ${(e as Error).message}`);
    process.exit(1);
  }

  const seqBefore = await sequences(teamAccounts());
  const shaBefore = Object.fromEntries(GENERATED.map((p) => [p, sha1(p)]));
  const ran: string[] = [];
  for (const s of STEPS) {
    let st = await settle(s.check);
    if (s.id === 'blend' && st.state === 'blocked' && WAIT_MIN > 0) {
      const until = Date.now() + WAIT_MIN * 60_000;
      while (st.state === 'blocked' && Date.now() < until) {
        console.log(`  blend: ${st.why}; checking again in 10 minutes (until ${new Date(until).toISOString()})`);
        await new Promise((r) => setTimeout(r, Math.min(10 * 60_000, Math.max(0, until - Date.now()))));
        st = await blendFactory();
      }
    }
    if ((s.needs ?? []).some((n) => status.get(n)?.state === 'blocked') && st.state === 'todo') st = blocked('waits for Blend');
    status.set(s.id, st);
    if (st.state === 'failed') {
      console.error(`\nFAILED at ${s.id}: ${st.why}; nothing was run for it`);
      process.exit(2);
    }
    if (!runs(st) || !s.run) continue;
    console.log(`\n== ${s.id}: ${st.why}`);
    ran.push(s.id);
    for (const argv of s.run) {
      if (!pnpm(argv)) {
        console.error(`\nFAILED at ${s.id} (pnpm ${argv.join(' ')}); fix it and run again: done steps are skipped`);
        process.exit(2);
      }
    }
    const after = await settle(s.check);
    status.set(s.id, after);
    if (after.state !== 'done') {
      console.error(`\nFAILED: ${s.id} still ${after.state} after running (${after.why})`);
      process.exit(2);
    }
  }

  console.log('\nafter --run:');
  table();
  const seqAfter = await sequences(teamAccounts());
  const moved = Object.keys(seqAfter).filter((pk) => seqBefore[pk] !== seqAfter[pk]);
  console.log(`\nidempotency: ${moved.length ? `${moved.length} team account(s) submitted transactions: ${moved.join(', ')}` : '0 transactions submitted (idempotent)'}`);
  for (const p of GENERATED) {
    const now = sha1(p);
    console.log(`  ${now === shaBefore[p] ? 'unchanged' : 'CHANGED  '} ${p}`);
  }
  if (ran.length === 1 && ran[0] === 'pool-ttl') console.log('  (only pool-ttl ran: a TTL extension by the pool admin is maintenance, not a rebuild)');
  productionBlock();
  process.exit(exitCode([...status.values()].map((v) => v.state), true));
}

main().catch((e) => {
  console.error('redeploy-after-reset:', (e as Error).message);
  process.exit(2);
});
