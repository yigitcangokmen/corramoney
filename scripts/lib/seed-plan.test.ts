import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetIds, offerPairs, planSeed, ROLES, type ChainState, type Role } from './seed-plan';

const keys = Object.fromEntries(ROLES.map((r, i) => [r, `G${String(i).repeat(55)}`])) as Record<Role, string>;
const ids = assetIds(keys);
const line = (id: string, balance = '100.0000000') => ({ code: id.split(':')[0], issuer: id.split(':')[1], balance });
const CODES = ['USDC', 'TESTMXN', 'TESTPHP', 'TESTBRL', 'TESTARS', 'TESTIDR', 'TESTTHB'];

/** Today's testnet: everything exists, funded, offered and deployed. */
function full(): ChainState {
  const acct = (balances: ReturnType<typeof line>[] = []) => ({ exists: true, balances });
  return {
    accounts: {
      usdcIssuer: acct(), corridorIssuer: acct(), feeSponsor: acct(),
      marketMaker: acct(CODES.map((c) => line(ids[c]))),
      anchorDistribution: acct([line(ids.TESTMXN), line(ids.TESTPHP, '0.0000000')]),
    },
    offers: offerPairs(keys),
    sacs: Object.fromEntries(CODES.map((c) => [c, true])),
  };
}

function empty(): ChainState {
  const none = { exists: false, balances: [] };
  return {
    accounts: { usdcIssuer: none, corridorIssuer: none, anchorDistribution: none, marketMaker: none, feeSponsor: none },
    offers: [], sacs: {},
  };
}

test('SP1 the full state plans nothing', () => {
  assert.deepEqual(planSeed(full(), keys), []);
});

test('SP2 the empty state (after a reset) plans everything, in order', () => {
  const plan = planSeed(empty(), keys);
  assert.deepEqual(plan.filter((a) => a.kind === 'fund').map((a) => (a as any).role), ROLES);
  const trust = plan.filter((a) => a.kind === 'trust') as any[];
  assert.deepEqual(trust.map((t) => [t.role, t.codes.length]), [['marketMaker', 7], ['anchorDistribution', 2]]);
  assert.deepEqual(trust[1].codes, ['TESTMXN', 'TESTPHP']);
  const issues = plan.filter((a) => a.kind === 'issue') as any[];
  assert.deepEqual(issues.map((i) => `${i.to}:${i.code}`), [
    'marketMaker:USDC', ...CODES.slice(1).map((c) => `marketMaker:${c}`), 'anchorDistribution:TESTMXN',
  ]);
  const offers = plan.filter((a) => a.kind === 'offers') as any[];
  assert.equal(offers.length, 1);
  assert.equal(offers[0].pairs.length, 12);
  assert.deepEqual(plan.filter((a) => a.kind === 'sac').map((a) => (a as any).code), CODES);
  assert.deepEqual([...new Set(plan.map((a) => a.kind))], ['fund', 'trust', 'issue', 'offers', 'sac']);
});

test('SP3 one missing direction of TESTARS plans one offers action with that pair', () => {
  const s = full();
  s.offers = s.offers.filter((o) => !(o.selling === ids.TESTARS && o.buying === ids.USDC));
  assert.deepEqual(planSeed(s, keys), [{ kind: 'offers', pairs: [{ selling: ids.TESTARS, buying: ids.USDC }] }]);
});

test('SP4 a distribution account without TESTPHP gets one trust and no issue', () => {
  const s = full();
  s.accounts.anchorDistribution.balances = [line(ids.TESTMXN)];
  assert.deepEqual(planSeed(s, keys), [{ kind: 'trust', role: 'anchorDistribution', codes: ['TESTPHP'] }]);
});

test('SP5 a balance above 0 never plans an issue (no top-up)', () => {
  const s = full();
  s.accounts.marketMaker.balances = CODES.map((c) => line(ids[c], '0.0000001'));
  s.accounts.anchorDistribution.balances = [line(ids.TESTMXN, '0.0000001'), line(ids.TESTPHP, '0')];
  assert.ok(!planSeed(s, keys).some((a) => a.kind === 'issue'));
  s.accounts.marketMaker.balances[3] = line(ids.TESTBRL, '0.0000000');
  assert.deepEqual(planSeed(s, keys).filter((a) => a.kind === 'issue').map((a) => (a as any).code), ['TESTBRL']);
});
