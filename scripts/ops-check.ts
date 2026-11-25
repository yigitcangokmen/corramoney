/**
 * Is a Corra deployment ready for users? Read-only checks from outside, against Stellar TESTNET and
 * the given services; /health itself stays a liveness probe. Prints PASS, WARN or FAIL per check
 * (public figures only, never a secret); exit 1 on any FAIL.
 *
 *   pnpm ops-check                                            the local stack
 *   ORCHESTRATOR_URL=https://api.corra.money ANCHOR_DOMAIN=anchor.corra.money STATS_URL=https://stats.corra.money pnpm ops-check
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { COUNT_JS_SRI } from '../apps/web/src/logic/analytics';
import { TESTNET, TESTNET_BLEND, TESTNET_CHANNELS } from '../packages/shared/src';
import { checkKeyFiles } from './lib/keys';
import { statsSiteLevel } from './lib/ops';
import { minDaysLeft, sharedKeys, verifyPool } from './lib/pool';
import { offerPairs, type Role } from './lib/seed-plan';
import { accountOrNull, channelState, corridorPaths, missingDestTrust, readChainState, xlmOf } from './lib/testnet-state';

const API = process.env.ORCHESTRATOR_URL ?? 'http://localhost:8787';
const ANCHOR = process.env.ANCHOR_DOMAIN ?? 'localhost:8080';
const STATS = process.env.STATS_URL;
const anchorBase = ANCHOR.startsWith('localhost') ? `http://${ANCHOR}` : `https://${ANCHOR}`;

let fails = 0;
let warns = 0;
const out = (level: 'PASS' | 'WARN' | 'FAIL', check: string, detail: string) => {
  if (level === 'FAIL') fails++;
  if (level === 'WARN') warns++;
  console.log(`${level} ${check}: ${detail}`);
};

async function http(url: string, redirect: RequestRedirect = 'follow') {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: (e as Error).message };
  }
}

/** Runs one check; a throw is a FAIL with its message. */
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    out('FAIL', name, (e as Error).message);
  }
}

async function main() {
  console.log(`ops-check: orchestrator ${API}, anchor ${anchorBase}${STATS ? `, stats ${STATS}` : ''} (Stellar testnet)`);

  await check('orchestrator', async () => {
    const r = await http(`${API}/health`);
    out(r.status === 200 ? 'PASS' : 'FAIL', 'orchestrator', `/health ${r.status || r.text}`);
  });

  await check('sponsor', async () => {
    const xlm = await xlmOf(TESTNET.feeSponsor);
    if (xlm === null) return out('FAIL', 'sponsor', `${TESTNET.feeSponsor} does not exist`);
    out(xlm < 500 ? 'FAIL' : xlm < 2000 ? 'WARN' : 'PASS', 'sponsor', `${xlm.toFixed(2)} XLM (WARN < 2,000, FAIL < 500)`);
  });

  await check('channels', async () => {
    for (const [i, pk] of TESTNET_CHANNELS.entries()) {
      const c = await channelState(pk);
      if (!c.exists) out('FAIL', `channel ${i + 1}`, `${pk} does not exist (pnpm create-channels)`);
      else out(c.xlm < 50 ? 'FAIL' : c.xlm < 100 ? 'WARN' : 'PASS', `channel ${i + 1}`, `${c.xlm.toFixed(2)} XLM${c.ownSignerOnly ? '' : ', not shaped as a channel'}`);
    }
  });

  await check('distribution', async () => {
    const a: any = await accountOrNull(TESTNET.anchorDistribution);
    const line = (code: string) => a?.balances.find((b: any) => b.asset_code === code && b.asset_issuer === TESTNET.corridorIssuer);
    const [mxn, php] = [line('TESTMXN'), line('TESTPHP')];
    if (!mxn || !php) return out('FAIL', 'distribution', `${!a ? 'account missing' : `${!mxn ? 'TESTMXN' : 'TESTPHP'} line missing`}`);
    out(Number(mxn.balance) < 1_000_000 ? 'WARN' : 'PASS', 'distribution', `${Number(mxn.balance).toFixed(0)} TESTMXN, TESTPHP line present`);
  });

  await check('market maker', async () => {
    const keys = { usdcIssuer: TESTNET.usdcIssuer, corridorIssuer: TESTNET.corridorIssuer, anchorDistribution: TESTNET.anchorDistribution,
      marketMaker: TESTNET.marketMaker, feeSponsor: TESTNET.feeSponsor } as Record<Role, string>;
    const state = await readChainState(keys);
    const open = new Set(state.offers.map((o) => `${o.selling}>${o.buying}`));
    const have = offerPairs(keys).filter((p) => open.has(`${p.selling}>${p.buying}`)).length;
    const dead = (await corridorPaths(TESTNET.corridorIssuer)).filter((p) => !p.sourceAmount).map((p) => p.code);
    if (dead.length) return out('FAIL', 'market maker', `no path at 1000 units to ${dead.join(', ')}`);
    out(have < 12 ? 'WARN' : 'PASS', 'market maker', `${have} of 12 offer pairs, every corridor resolves at 1000 units`);
  });

  await check('anchor', async () => {
    const r = await http(`${anchorBase}/sep24/info`);
    if (r.status !== 200) return out('FAIL', 'anchor', `/sep24/info ${r.status || r.text}`);
    const info = JSON.parse(r.text);
    const problems = [
      !info.deposit?.TESTMXN?.enabled && 'TESTMXN deposit missing',
      !info.withdraw?.TESTPHP?.enabled && 'TESTPHP withdraw missing',
      info.withdraw?.TESTMXN?.enabled && 'TESTMXN withdraw present',
    ].filter(Boolean);
    out(problems.length ? 'FAIL' : 'PASS', 'anchor', problems.length ? problems.join(', ') : 'TESTMXN deposit, TESTPHP withdraw');
  });

  await check('pool', async () => {
    if (!TESTNET_BLEND) return out('FAIL', 'pool', 'not deployed (testnet-blend.ts is null)');
    await verifyPool(TESTNET_BLEND);
    const days = await minDaysLeft(await sharedKeys(TESTNET_BLEND.pool, TESTNET_BLEND.oracle, TESTNET_BLEND.asset));
    out(days < 21 ? 'WARN' : 'PASS', 'pool', `${TESTNET_BLEND.pool} verified, shared entries live ${days.toFixed(1)} more days${days < 21 ? ' (pnpm pool-ttl)' : ''}`);
  });

  await check('demo recipient', async () => {
    const r = (TESTNET as { demoRecipient?: string }).demoRecipient;
    if (!r) return out('FAIL', 'demo recipient', 'none in testnet.ts (pnpm demo-recipient)');
    const missing = await missingDestTrust(r, TESTNET.corridorIssuer);
    out(missing.length ? 'FAIL' : 'PASS', 'demo recipient', missing.length ? `missing ${missing.join(', ')}` : `${r} trusts the five destination assets`);
  });

  await check('keys', async () => {
    if (!existsSync('.env.testnet')) return out('WARN', 'keys', 'no .env.testnet here: key files not compared');
    const k = checkKeyFiles({
      env: readFileSync('.env.testnet', 'utf8'), testnetTs: readFileSync('packages/shared/src/testnet.ts', 'utf8'),
      channelsTs: readFileSync('packages/shared/src/testnet-channels.ts', 'utf8'), blendTs: readFileSync('packages/shared/src/testnet-blend.ts', 'utf8'),
    });
    const bad = k.base !== 'ok' || k.channels === 'mismatch' || k.poolAdmin === 'mismatch';
    out(bad ? 'FAIL' : 'PASS', 'keys', `base ${k.base}, channels ${k.channels}, pool admin ${k.poolAdmin}`);
  });

  if (STATS) {
    await check('stats', async () => {
      const r = await http(`${STATS}/count.js`);
      if (r.status !== 200) return out('WARN', 'stats', `${STATS}/count.js ${r.status || r.text}`);
      // The app loads count.js with this integrity: a different file is refused, so nothing is counted.
      const sri = `sha384-${createHash('sha384').update(r.text).digest('base64')}`;
      out(sri === COUNT_JS_SRI ? 'PASS' : 'FAIL', 'stats', `${STATS}/count.js 200, ${sri === COUNT_JS_SRI ? 'matches' : 'does not match'} the app's COUNT_JS_SRI`);
    });
    await check('stats site', async () => {
      // An empty GoatCounter offers its first-site form to anyone, who would then own the dashboard.
      const r = await http(`${STATS}/`, 'manual');
      const v = statsSiteLevel(r.status, r.text);
      out(v.level, 'stats site', `${STATS}/ ${v.detail}`);
    });
  }

  console.log(`\nops-check: ${fails} FAIL, ${warns} WARN`);
  if (fails) process.exit(1);
}

main().catch((e) => {
  console.error('ops-check:', (e as Error).message);
  process.exit(1);
});
