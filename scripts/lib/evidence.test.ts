import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Address, Keypair } from '@stellar/stellar-sdk';
import { TESTNET, TESTNET_BLEND, TESTNET_CHANNELS } from '../../packages/shared/src';
import {
  checkItems, citedByPhase, EMPTY_MANUAL, hashesIn, hashesOutsideBlock, ITEMS, lateSources, manualSources, originOf, phaseOf, redact, refreshedRpc, renderBlock, replaceBlock, resolve,
  sourcesOf, validateManual, BLOCK_END, BLOCK_START, type ItemId, type Manual, type Source,
} from './evidence';

const h = (n: number) => n.toString(16).padStart(64, '0');
const G1 = 'GASPVF43ZYIIYQXLPOP5ZRUMJCHRYXHN2RFB7TMDGVJSQET24PY2QR7M';
const G2 = 'GBJTBEZYCTO4MTBKZHAT5ZQIK74RNZ6F44YDPEG4IUBSGO65IPOGXQW5';
const POOL = TESTNET_BLEND!.pool;
const OTHER_C = 'CBFQSK4U76625W7GKZDMP47ATARCBA6F45EP65YGRQODQQ3GDSOG6NY5';
/** Horizon's invoke_host_function operation for `contract`.submit by `source`. */
const invoke = (source: string, contract: string) => ({ type: 'invoke_host_function', source_account: source,
  function: 'HostFunctionTypeHostFunctionTypeInvokeContract', parameters: [{ type: 'Address', value: Address.fromString(contract).toScVal().toXDR('base64') }] });

test('EV1 phaseOf: default pre-reset, post-reset ok, anything else throws', () => {
  assert.equal(phaseOf({}), 'pre-reset');
  assert.equal(phaseOf({ EVIDENCE_PHASE: 'post-reset' }), 'post-reset');
  assert.throws(() => phaseOf({ EVIDENCE_PHASE: 'post' }), /EVIDENCE_PHASE must be pre-reset or post-reset/);
  // C6-1: unset after the reset instant is an error, not a silent pre-reset; an explicit value still works
  const before = new Date('2026-12-16T16:59:59.999Z');
  const after = new Date('2026-12-16T17:00:00.000Z');
  assert.equal(phaseOf({}, before), 'pre-reset');
  assert.throws(() => phaseOf({}, after), /the testnet was reset: set EVIDENCE_PHASE=post-reset \(or pre-reset explicitly\)/);
  assert.throws(() => phaseOf({ EVIDENCE_PHASE: '' }, after), /the testnet was reset/);
  assert.equal(phaseOf({ EVIDENCE_PHASE: 'post-reset' }, after), 'post-reset');
  assert.equal(phaseOf({ EVIDENCE_PHASE: 'pre-reset' }, after), 'pre-reset');
});

test('EV2 originOf', () => {
  assert.equal(originOf('https://api.corra.money'), 'prod');
  assert.equal(originOf('https://api.corra.money/'), 'prod');
  assert.equal(originOf('http://localhost:8787'), 'local');
  assert.equal(originOf('http://127.0.0.1:8787'), 'local');
  assert.equal(originOf(undefined), 'local');
  assert.equal(originOf('https://staging.example.com'), 'other');
  assert.equal(originOf('http://localhost.evil.com'), 'other');
});

test('EV3 redact: token params, nesting, seeds, bigint', () => {
  assert.deepEqual(redact({ u: 'http://a/more_info?transaction_id=x&token=abc' }), { u: 'http://a/more_info?transaction_id=x' });
  assert.deepEqual(redact('http://a/p?token=abc&a=1'), 'http://a/p?a=1');
  assert.deepEqual(redact('http://a/p?a=1&token=abc&b=2'), 'http://a/p?a=1&b=2');
  assert.deepEqual(redact({ a: [{ b: { url: 'x?token=t' } }] }), { a: [{ b: { url: 'x' } }] });
  assert.deepEqual(redact('<a href="/m?id=1&amp;token=zz">'), '<a href="/m?id=1">');
  assert.deepEqual(redact({ n: 10n, m: [1n] }), { n: '10', m: ['1'] });
  assert.throws(() => redact({ deep: ['S' + 'A'.repeat(55)] }), /seed/);
  // C6-2: a seed in a URL path, after '+', before '/' or '=' is still a seed
  const seed = Keypair.random().secret();
  for (const shape of [`https://x/keys/${seed}`, `a+${seed}`, `${seed}/b`, `${seed}=`]) assert.throws(() => redact({ v: shape }), /seed/, shape);
  const input = { x: { y: 'keep' } };
  const out = redact(input) as typeof input;
  assert.notEqual(out.x, input.x);
});

const balanceFixture = {
  phase: 'pre-reset', origin: 'local', orchestrator: 'http://localhost:8787', writtenAt: '2026-11-26T10:00:00.000Z',
  sender: G1, paymentAccount: G2, recipient: TESTNET.demoRecipient, deposit: 'anchor',
  setup: { account: h(1), paymentAccount: h(2) },
  depositRow: { id: 'dep_1', status: 'CONFIRMED', matchedBy: 'ref', anchorRef: 'r1', txHash: h(3), credited: '2000.0000000' },
  sends: ['PHP', 'BRL', 'ARS', 'IDR', 'THB'].map((fiat, i) => ({
    fiat, paymentId: `pmt_${i}`, publicId: `CORRA-${i}`, txHash: h(10 + i), ledger: 100 + i, state: 'CREDITED', dest: `1 TEST${fiat}`,
  })),
  inProgressProbe: { status: 409, code: 'PAYMENT_IN_PROGRESS' },
};

test('EV4 sourcesOf: one fixture per prefix; a file without origin is local', () => {
  const b = sourcesOf('pre-reset/d1/balance-check-2026-11-26T10-00-00-000Z.json', balanceFixture);
  assert.deepEqual(b.map((s) => s.item), ['D1.deposit', 'D1.send.PHP', 'D1.send.BRL', 'D1.send.ARS', 'D1.send.IDR', 'D1.send.THB']);
  assert.ok(b.every((s) => s.account === G1 && s.origin === 'local' && s.phase === 'pre-reset'));
  assert.equal(b[1].hashes[0].hash, h(10));

  const appRun = {
    phase: 'post-reset', origin: 'prod', writtenAt: '2026-12-20T10:00:00.000Z', account: G1, recipient: G2, viaApp: true,
    deposits: [{ id: 'dep_1', status: 'CONFIRMED', txHash: h(3), matchedBy: 'ref', anchorRef: 'r' }],
    payments: [{ kind: 'balance', state: 'CREDITED', destAsset: 'TESTPHP', destAmount: '500', txHash: h(4), ledger: 9, publicId: 'CORRA-A' }],
    pool: { ops: [{ kind: 'supply', status: 'SUCCESS', txHash: h(5), innerHash: h(6), ledger: 10 }, { kind: 'withdraw', status: 'SUCCESS', txHash: h(7), innerHash: h(8), ledger: 11 }] },
    cashOuts: [{ status: 'CONFIRMED', txHash: h(9), ledger: 12 }],
  };
  const app = sourcesOf('post-reset/app/app-run-GASPVF43-2026-12-20T10-00-00-000Z.json', appRun);
  assert.deepEqual(app.map((s) => s.item), ['D1.deposit', 'D1.send.PHP', 'D1.hosted', 'D2.supply', 'D2.withdraw', 'D3.withdrawal']);
  assert.equal(app[0].origin, 'prod');
  // S3-3: a run on api.corra.money without --via-app (a script sender) is not the hosted app flow
  const script = sourcesOf('post-reset/app/app-run-GASPVF43-2026-12-20T11-00-00-000Z.json', { ...appRun, viaApp: false });
  assert.deepEqual(script.map((s) => s.item), ['D1.deposit', 'D1.send.PHP', 'D2.supply', 'D2.withdraw', 'D3.withdrawal']);
  assert.ok(!renderBlock(resolve(script, EMPTY_MANUAL), EMPTY_MANUAL).includes('app.corra.money, post-reset'));
  assert.match(renderBlock(resolve(script, EMPTY_MANUAL), EMPTY_MANUAL), /through api\.corra\.money, post-reset/);

  const deploy = sourcesOf('pre-reset/d2/deploy-pool-2026-11-24T13-41-57-134Z.json', {
    ledger: 5900814, ids: { pool: 'CAL5ZEAT7XIP5B7AAUJD6WOVG2W7YDIE27HNF7ABQIC3HBOC42TQFWHS', admin: 'G' },
    steps: [{ label: 'pool deploy', hash: h(20), ledger: 5900811 }],
  });
  assert.equal(deploy[0].item, 'D2.contract');
  assert.equal(deploy[0].origin, 'local');
  assert.equal(deploy[0].at, '2026-11-24T13:41:57.134Z');
  assert.match(deploy[0].links[0].url, /contract\/CAL5ZEAT/);

  const pool = sourcesOf('pre-reset/d2/pool-check-2026-11-25T07-27-30-194Z.json', {
    account: G1, supply: { outer: h(30), inner: h(31), ledger: 1 }, withdraw: { outer: h(32), inner: h(33), ledger: 2 },
  });
  assert.deepEqual(pool.map((s) => [s.item, s.hashes.map((x) => x.label)]), [['D2.supply', ['fee-bump', 'inner']], ['D2.withdraw', ['fee-bump', 'inner']]]);

  const co = sourcesOf('pre-reset/d3/cash-out-2026-11-25T07-25-04-237Z.json', {
    recipient: G2, anchor: { id: 'abc', status: 'completed', payout: 'sim' }, withdrawal: { envelope: h(40), inner: h(41), ledger: 5 },
    moreInfoHtml: 'pre-reset/d3/more-info-abc.html',
  });
  assert.deepEqual(co.map((s) => s.item), ['D3.withdrawal', 'D3.anchorPage']);
  assert.deepEqual(co[1].files, ['pre-reset/d3/more-info-abc.html']);

  const cs = sourcesOf('pre-reset/d3/concurrent-setups-2026-11-25T08-59-15-712Z.json', {
    ledger: 7, users: [0, 1, 2].map((i) => ({ channel: TESTNET_CHANNELS[i], accountTx: h(50 + i), paymentAccountTx: h(60 + i) })),
  });
  assert.equal(cs[0].item, 'D3.setups');
  assert.equal(cs[0].hashes.length, 3);
});

const src = (item: ItemId, over: Partial<Source> = {}): Source => ({
  item, phase: 'pre-reset', origin: 'local', file: `pre-reset/d1/x-${item}.json`, at: '2026-11-26T00:00:00.000Z', hashes: [], links: [], files: [], ...over,
});

test('EV5 selection: post-reset, then freighter > prod > local > other, then newest; pins override', () => {
  const s = [
    src('D2.supply', { file: 'a', origin: 'local', at: '2026-11-27' }),
    src('D2.supply', { file: 'b', origin: 'prod', at: '2026-11-26' }),
    src('D2.supply', { file: 'c', origin: 'freighter', at: '2026-11-25' }),
    src('D2.supply', { file: 'd', origin: 'other', at: '2026-11-28' }),
  ];
  assert.equal(resolve(s, EMPTY_MANUAL).get('D2.supply')!.primary!.file, 'c');
  const post = [...s, src('D2.supply', { file: 'e', origin: 'local', phase: 'post-reset', at: '2026-12-20' })];
  const r = resolve(post, EMPTY_MANUAL);
  assert.equal(r.get('D2.supply')!.primary!.file, 'e');
  assert.equal(r.get('D2.supply')!.archived!.file, 'c');
  const newest = [src('D2.withdraw', { file: 'old', at: '2026-11-25' }), src('D2.withdraw', { file: 'new', at: '2026-11-26' })];
  assert.equal(resolve(newest, EMPTY_MANUAL).get('D2.withdraw')!.primary!.file, 'new');
  const pinned: Manual = { ...EMPTY_MANUAL, pins: { 'D2.supply': 'a' } };
  assert.equal(resolve(s, pinned).get('D2.supply')!.primary!.file, 'a');
  assert.equal(resolve(post, EMPTY_MANUAL, 'pre-reset').get('D2.supply')!.primary!.file, 'c');
});

const d1 = (file: string, account: string, at: string, items: ItemId[]) =>
  items.map((item) => src(item, { file, account, at, hashes: [{ label: 'x', hash: h(item.length + file.length) }] }));
const ALL_D1: ItemId[] = ['D1.deposit', 'D1.send.PHP', 'D1.send.BRL', 'D1.send.ARS', 'D1.send.IDR', 'D1.send.THB'];

test('EV6 D1 group: a complete older file beats a newer partial; different senders never merge', () => {
  const s = [...d1('old', G1, '2026-11-25', ALL_D1), ...d1('new', G1, '2026-11-27', ['D1.deposit', 'D1.send.PHP'])];
  const r = resolve(s, EMPTY_MANUAL);
  assert.ok(ALL_D1.every((id) => r.get(id)!.primary!.file === 'old'));
  assert.equal(r.get('D1.deposit')!.warning, undefined);

  const split = [...d1('a', G1, '2026-11-25', ['D1.deposit', 'D1.send.PHP', 'D1.send.BRL']), ...d1('b', G2, '2026-11-26', ['D1.send.ARS', 'D1.send.IDR', 'D1.send.THB'])];
  const r2 = resolve(split, EMPTY_MANUAL);
  assert.ok(ALL_D1.every((id) => r2.get(id)!.warning === undefined));
  assert.equal(r2.get('D1.deposit')!.primary!.account, G1);
  assert.equal(r2.get('D1.send.THB')!.primary!.account, G2);
  assert.ok(checkItems(r2, mkdtempSync(join(tmpdir(), 'ev6-'))).includes('D1: the deposit and the five sends are not one sender'));

  const assembled = [...d1('a', G1, '2026-11-25', ['D1.deposit', 'D1.send.PHP', 'D1.send.BRL']), ...d1('b', G1, '2026-11-26', ['D1.send.ARS', 'D1.send.IDR', 'D1.send.THB'])];
  const r3 = resolve(assembled, EMPTY_MANUAL);
  assert.equal(r3.get('D1.deposit')!.warning, 'assembled from 2 runs');
  assert.equal(r3.get('D1.send.THB')!.primary!.file, 'b');
});

test('EV7 renderBlock is byte-stable; replaceBlock is idempotent and leaves the rest alone', () => {
  const s = [...d1('f', G1, '2026-11-25', ALL_D1), src('D2.supply', { hashes: [{ label: 'fee-bump', hash: h(1) }], ledger: 5 })];
  const block = renderBlock(resolve(s, EMPTY_MANUAL), EMPTY_MANUAL);
  assert.equal(renderBlock(resolve([...s].reverse(), EMPTY_MANUAL), EMPTY_MANUAL), block);
  assert.ok(block.startsWith(BLOCK_START) && block.endsWith(BLOCK_END));
  assert.ok(!block.includes('token='));
  const md = '# Evidence\n\nmonth one text\n';
  const once = replaceBlock(md, block);
  assert.ok(once.startsWith(md.trimEnd()));
  assert.equal(replaceBlock(once, block), once);
  const other = replaceBlock(once, block.replace('Deliverable 1', 'Deliverable One'));
  assert.equal(other.slice(0, once.indexOf(BLOCK_START)), once.slice(0, once.indexOf(BLOCK_START)));
  assert.equal(other.slice(other.indexOf(BLOCK_END)), once.slice(once.indexOf(BLOCK_END)));
  assert.throws(() => replaceBlock(once + block, block), /exactly once/);
});

/** A root where every item has a passing primary: each mutation must add exactly one problem line. */
function goodFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ev8-'));
  const tx = (hash: string, transaction: object, operations: object[]) => {
    mkdirSync(`${root}/pre-reset/tx`, { recursive: true });
    writeFileSync(`${root}/pre-reset/tx/${hash}.json`, JSON.stringify({ hash, horizon: { transaction, operations, effects: [] } }));
  };
  const ok = { successful: true, fee_account: TESTNET.feeSponsor };
  const sources: Source[] = [];
  ALL_D1.forEach((item, i) => {
    const hash = h(100 + i);
    sources.push(src(item, { file: 'pre-reset/d1/run.json', account: G1, hashes: [{ label: 'x', hash }], ...(item === 'D1.deposit' ? { anchorRef: 'r1' } : {}) }));
    tx(hash, ok, item === 'D1.deposit'
      ? [{ type: 'payment', from: TESTNET.anchorDistribution, to: G1, asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer }]
      : [{ type: 'path_payment_strict_receive', source_account: G1, asset_code: `TEST${item.slice(-3)}`, asset_issuer: TESTNET.corridorIssuer }]);
  });
  mkdirSync(`${root}/pre-reset/d1`, { recursive: true });
  writeFileSync(`${root}/pre-reset/d1/run.json`, '{}');
  for (const [i, item] of (['D2.supply', 'D2.withdraw'] as const).entries()) {
    sources.push(src(item, { file: 'pre-reset/d1/run.json', account: G1, hashes: [{ label: 'fee-bump', hash: h(200 + i) }] }));
    tx(h(200 + i), { ...ok, source_account: G2 }, [invoke(G1, POOL)]);
  }
  sources.push(src('D3.withdrawal', { file: 'pre-reset/d1/run.json', account: G1, hashes: [{ label: 'w', hash: h(300) }] }));
  tx(h(300), ok, [{ type: 'payment', from: G1, to: TESTNET.anchorDistribution, asset_code: 'TESTPHP', asset_issuer: TESTNET.corridorIssuer }]);
  const setups = [0, 1, 2].map((i) => h(400 + i));
  sources.push(src('D3.setups', { file: 'pre-reset/d1/run.json', hashes: setups.map((hash, i) => ({ label: `s${i}`, hash })) }));
  setups.forEach((hash, i) => tx(hash, { ...ok, source_account: TESTNET_CHANNELS[i], ledger: 7 }, []));
  for (const item of ['D1.history', 'D2.position', 'D3.ci', 'video'] as const) {
    sources.push(src(item, { file: 'manual.json' }));
  }
  sources.push(src('D2.contract', { file: 'manual.json', links: [{ label: 'pool', url: `https://stellar.expert/explorer/testnet/contract/${POOL}` }] }));
  mkdirSync(`${root}/pre-reset/d3`, { recursive: true });
  for (const f of ['pre-reset/d1/hosted-1440.png', 'pre-reset/d3/anchor-page-1440.png', 'pre-reset/d3/more-info-a.html']) writeFileSync(`${root}/${f}`, 'x');
  sources.push(src('D1.hosted', { file: 'manual.json', files: ['pre-reset/d1/hosted-1440.png'] }));
  sources.push(src('D3.anchorPage', { file: 'manual.json', files: ['pre-reset/d3/more-info-a.html', 'pre-reset/d3/anchor-page-1440.png'] }));
  return { root, sources, tx };
}

test('EV8 checkItems: missing archive, token=, two equal channels, wrong fee account, setups count, corridor asset, deposit payer, screenshots: one line each', async () => {
  const { unlinkSync } = await import('node:fs');
  const base = goodFixture();
  assert.deepEqual(checkItems(resolve(base.sources, EMPTY_MANUAL), base.root), []);

  const a = goodFixture();
  unlinkSync(`${a.root}/pre-reset/tx/${h(200)}.json`);
  const ra = checkItems(resolve(a.sources, EMPTY_MANUAL), a.root);
  assert.equal(ra.length, 1);
  assert.match(ra[0], /D2.supply: 0+c8 not archived/);

  const b = goodFixture();
  writeFileSync(`${b.root}/pre-reset/d1/page.html`, '<a href="/more_info?id=1&token=abc">');
  const rb = checkItems(resolve(b.sources, EMPTY_MANUAL), b.root);
  assert.equal(rb.length, 1);
  assert.match(rb[0], /page.html: holds token=/);

  const c = goodFixture();
  c.tx(h(401), { successful: true, fee_account: TESTNET.feeSponsor, source_account: TESTNET_CHANNELS[0], ledger: 7 }, []);
  const rc = checkItems(resolve(c.sources, EMPTY_MANUAL), c.root);
  assert.deepEqual(rc, ['D3.setups: the three sources are not distinct']);

  const d = goodFixture();
  d.tx(h(101), { successful: true, fee_account: G2 }, [{ type: 'path_payment_strict_receive', source_account: G1 }]);
  const rd = checkItems(resolve(d.sources, EMPTY_MANUAL), d.root);
  assert.equal(rd.length, 1);
  assert.match(rd[0], /D1.send.PHP: .* fee account G[A-Z2-7]+, not the sponsor/);

  // S2-5: the withdrawal is presented as the sponsor's fee-bump: a failed one, or one another account paid, is flagged
  const f = goodFixture();
  f.tx(h(300), { successful: true, fee_account: G2 }, [{ type: 'payment', from: G1, to: TESTNET.anchorDistribution, asset_code: 'TESTPHP', asset_issuer: TESTNET.corridorIssuer }]);
  assert.deepEqual(checkItems(resolve(f.sources, EMPTY_MANUAL), f.root), [`D3.withdrawal: ${h(300)} fee account ${G2}, not the sponsor`]);
  const g = goodFixture();
  g.tx(h(300), { successful: false, fee_account: TESTNET.feeSponsor }, [{ type: 'payment', from: G1, to: TESTNET.anchorDistribution, asset_code: 'TESTPHP', asset_issuer: TESTNET.corridorIssuer }]);
  assert.deepEqual(checkItems(resolve(g.sources, EMPTY_MANUAL), g.root), [`D3.withdrawal: ${h(300)} not successful`]);

  // S2-5: after a post-reset primary exists, the pre-reset source EVIDENCE.md still links is claim-checked too,
  // against its own phase's tx folder
  const p = goodFixture();
  p.tx(h(200), { successful: true, fee_account: G2 }, [invoke(G1, POOL)]);
  mkdirSync(`${p.root}/post-reset/tx`, { recursive: true });
  mkdirSync(`${p.root}/post-reset/d2`, { recursive: true });
  writeFileSync(`${p.root}/post-reset/d2/run.json`, '{}');
  writeFileSync(`${p.root}/post-reset/tx/${h(250)}.json`, JSON.stringify({ hash: h(250),
    horizon: { transaction: { successful: true, fee_account: TESTNET.feeSponsor }, operations: [invoke(G1, POOL)], effects: [] } }));
  const post = [...p.sources, src('D2.supply', { phase: 'post-reset', file: 'post-reset/d2/run.json', account: G1, hashes: [{ label: 'fee-bump', hash: h(250) }] })];
  const rp = resolve(post, EMPTY_MANUAL);
  assert.equal(rp.get('D2.supply')?.archived?.phase, 'pre-reset');
  assert.deepEqual(checkItems(rp, p.root), [`D2.supply (pre-reset): ${h(200)} fee account ${G2}, not the sponsor`]);

  // S6-2: a pool op another account signed, or one that invokes another contract, is flagged
  const w = goodFixture();
  w.tx(h(200), { successful: true, fee_account: TESTNET.feeSponsor, source_account: G2 }, [invoke(G2, POOL)]);
  assert.deepEqual(checkItems(resolve(w.sources, EMPTY_MANUAL), w.root), [`D2.supply: ${h(200)} source ${G2}, not the supplier ${G1}`]);
  const x = goodFixture();
  x.tx(h(201), { successful: true, fee_account: TESTNET.feeSponsor, source_account: G2 }, [invoke(G1, OTHER_C)]);
  assert.deepEqual(checkItems(resolve(x.sources, EMPTY_MANUAL), x.root), [`D2.withdraw: ${h(201)} invokes ${OTHER_C}, not the pool ${POOL}`]);
  // S6-2: a TESTPHP payment to the distribution account from someone other than the recipient is not the withdrawal
  const y = goodFixture();
  y.tx(h(300), { successful: true, fee_account: TESTNET.feeSponsor }, [{ type: 'payment', from: G2, to: TESTNET.anchorDistribution, asset_code: 'TESTPHP', asset_issuer: TESTNET.corridorIssuer }]);
  assert.deepEqual(checkItems(resolve(y.sources, EMPTY_MANUAL), y.root), [`D3.withdrawal: ${h(300)} has no TESTPHP payment from the recipient to the anchor's distribution account`]);

  // C3-4: a D3.setups item citing other than three transactions is flagged
  const k = goodFixture();
  const two = k.sources.map((x) => (x.item === 'D3.setups' ? { ...x, hashes: x.hashes.slice(0, 2) } : x));
  assert.deepEqual(checkItems(resolve(two, EMPTY_MANUAL), k.root), ['D3.setups: 2 transaction(s) cited, not three']);
  const four = k.sources.map((x) => (x.item === 'D3.setups' ? { ...x, hashes: [...x.hashes, { label: 's3', hash: h(400) }] } : x));
  assert.deepEqual(checkItems(resolve(four, EMPTY_MANUAL), k.root, false), ['D3.setups: 4 transaction(s) cited, not three']);

  // S3-4: a send that delivers another corridor's asset, or another issuer's, is flagged
  const m = goodFixture();
  m.tx(h(101), { successful: true, fee_account: TESTNET.feeSponsor }, [{ type: 'path_payment_strict_receive', source_account: G1, asset_code: 'TESTBRL', asset_issuer: TESTNET.corridorIssuer }]);
  assert.deepEqual(checkItems(resolve(m.sources, EMPTY_MANUAL), m.root), [`D1.send.PHP: ${h(101)} the path payment does not deliver TESTPHP of the corridor issuer`]);
  const m2 = goodFixture();
  m2.tx(h(101), { successful: true, fee_account: TESTNET.feeSponsor }, [{ type: 'path_payment_strict_receive', source_account: G1, asset_code: 'TESTPHP', asset_issuer: G2 }]);
  assert.deepEqual(checkItems(resolve(m2.sources, EMPTY_MANUAL), m2.root), [`D1.send.PHP: ${h(101)} the path payment does not deliver TESTPHP of the corridor issuer`]);
  // S3-4: five sends citing one transaction twice
  const n = goodFixture();
  const dup = n.sources.map((x) => (x.item === 'D1.send.BRL' ? { ...x, hashes: [{ label: 'x', hash: h(101) }] } : x));
  n.tx(h(101), { successful: true, fee_account: TESTNET.feeSponsor }, [
    { type: 'path_payment_strict_receive', source_account: G1, asset_code: 'TESTPHP', asset_issuer: TESTNET.corridorIssuer },
    { type: 'path_payment_strict_receive', source_account: G1, asset_code: 'TESTBRL', asset_issuer: TESTNET.corridorIssuer }]);
  assert.deepEqual(checkItems(resolve(dup, EMPTY_MANUAL), n.root), ['D1: the five sends are not five distinct transactions']);
  // S3-4: the deposit must be a TESTMXN payment from the anchor's distribution account to the sender
  for (const [what, op] of [
    ['another payer', { from: G2, to: G1, asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer }],
    ['another payee', { from: TESTNET.anchorDistribution, to: G2, asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer }],
    ['another asset', { from: TESTNET.anchorDistribution, to: G1, asset_code: 'TESTPHP', asset_issuer: TESTNET.corridorIssuer }],
  ] as const) {
    const q = goodFixture();
    q.tx(h(100), { successful: true, fee_account: TESTNET.feeSponsor }, [{ type: 'payment', ...op }]);
    assert.deepEqual(checkItems(resolve(q.sources, EMPTY_MANUAL), q.root),
      [`D1.deposit: ${h(100)} has no successful TESTMXN payment from the anchor's distribution account to the sender`], what);
  }

  // S3-3: a manual D1.hosted entry needs its app.corra.money screenshot
  const u = goodFixture();
  const noShot = u.sources.map((x) => (x.item === 'D1.hosted' ? { ...x, files: [] } : x));
  assert.deepEqual(checkItems(resolve(noShot, EMPTY_MANUAL), u.root), ['D1.hosted: no app.corra.money screenshot (a .png in its files)']);

  // C3-2: the anchor page's screenshot: claimed in EVIDENCE.md only when cited; required at --final
  const v = goodFixture();
  const htmlOnly = v.sources.map((x) => (x.item === 'D3.anchorPage' ? { ...x, files: ['pre-reset/d3/more-info-a.html'] } : x));
  assert.deepEqual(checkItems(resolve(htmlOnly, EMPTY_MANUAL), v.root), []);
  assert.deepEqual(checkItems(resolve(htmlOnly, EMPTY_MANUAL), v.root, true), ["D3.anchorPage: no screenshot of the anchor's page (a .png in its files)"]);
  const pending = renderBlock(resolve(htmlOnly, EMPTY_MANUAL), EMPTY_MANUAL);
  assert.match(pending, /shown by a saved copy of its HTML with the token removed \(screenshot pending\)/);
  assert.ok(!pending.includes('a screenshot and a saved copy'));
  assert.match(renderBlock(resolve(v.sources, EMPTY_MANUAL), EMPTY_MANUAL), /shown by a screenshot and a saved copy of its HTML/);

  // the builder items may be pending until --final
  const e = goodFixture();
  const rest = e.sources.filter((s) => s.item !== 'video');
  assert.deepEqual(checkItems(resolve(rest, EMPTY_MANUAL), e.root), []);
  assert.deepEqual(checkItems(resolve(rest, EMPTY_MANUAL), e.root, true), ['video: no evidence']);
});

test('EV9 validateManual refuses unknown keys and item ids', () => {
  const good = { items: [{ item: 'D1.history', phase: 'pre-reset', origin: 'freighter', files: ['pre-reset/d1/history-1440.png'], note: 'n' }],
    pins: {}, notes: { reset: '', blend: '' }, deviations: [] };
  assert.equal(validateManual(good).items[0].item, 'D1.history');
  assert.equal(manualSources(validateManual(good))[0].file, 'manual.json');
  assert.throws(() => validateManual({ ...good, extra: 1 }), /unknown key manual.extra/);
  assert.throws(() => validateManual({ ...good, items: [{ ...good.items[0], item: 'D9.x' }] }), /not an item id/);
  assert.throws(() => validateManual({ ...good, items: [{ ...good.items[0], color: 'red' }] }), /unknown key items\[0\].color/);
  assert.throws(() => validateManual({ ...good, items: [{ ...good.items[0], phase: 'later' }] }), /phase/);
  assert.throws(() => validateManual({ ...good, pins: { 'D9.x': 'f' } }), /pins.D9.x/);
  assert.throws(() => validateManual({ ...good, items: [{ ...good.items[0], hashes: [{ label: 'x', hash: 'ABC' }] }] }), /64-hex/);
  assert.throws(() => validateManual({ ...good, notes: { reset: '', other: '' } }), /notes.other/);
  assert.ok(ITEMS.length === 17);
  // S5-2: the walkthrough video is submitted privately; EVIDENCE.md is public.
  const video = { item: 'video', phase: 'pre-reset', origin: 'other', note: 'sent to the Chapter Lead on 2026-12-14' };
  const vm = validateManual({ ...good, items: [video] });
  for (const [k, v] of [['links', [{ label: 'walkthrough', url: 'https://youtu.be/private' }]], ['files', ['video.mp4']], ['hashes', [{ label: 'x', hash: h(1) }]]] as const) {
    assert.throws(() => validateManual({ ...good, items: [{ ...video, [k]: v }] }), /video takes only a note/);
  }
  assert.throws(() => validateManual({ ...good, items: [{ ...video, note: 'at https://youtu.be/private' }] }), /must not hold a link/);
  const block = renderBlock(resolve(manualSources(vm), vm), vm);
  const row = block.split('\n').find((l) => l.startsWith('| One walkthrough video'))!;
  assert.match(row, /submitted privately \(link not published\); sent to the Chapter Lead on 2026-12-14/);
  assert.ok(!/https?:/.test(row));
});

test('EV10 hashesIn finds 64-hex at depth with its path; ignores 63/65 chars and uppercase', () => {
  const found = hashesIn({ a: h(1), b: [{ c: h(2) }], d: 'f'.repeat(63), e: 'f'.repeat(65), f: 'F'.repeat(64), g: 5 });
  assert.deepEqual(found, [{ hash: h(1), path: 'a' }, { hash: h(2), path: 'b[0].c' }]);
});

test('EV11 D1.deposit needs the anchor link: a newer direct run loses to an older anchor run; checkItems flags an unlinked deposit', () => {
  const direct = { ...balanceFixture, writtenAt: '2026-11-27T10:00:00.000Z', sender: G2, deposit: 'direct',
    depositRow: { ...balanceFixture.depositRow, id: 'dep_2', matchedBy: 'chain', anchorRef: null, txHash: h(70) } };
  const ds = sourcesOf('pre-reset/d1/balance-check-2026-11-27T10-00-00-000Z.json', direct);
  assert.ok(!ds.some((s) => s.item === 'D1.deposit'), 'a direct deposit is not D1 evidence');
  // a late link on a chain match is still not the anchor-linked deposit the SOW names
  assert.ok(!sourcesOf('pre-reset/d1/balance-check-x.json', { ...direct, deposit: 'anchor', depositRow: { ...direct.depositRow, anchorRef: 'late' } })
    .some((s) => s.item === 'D1.deposit'));
  assert.ok(!sourcesOf('pre-reset/app/app-run-x.json', { account: G1, deposits: [{ id: 'd', status: 'CONFIRMED', txHash: h(71), matchedBy: 'chain', anchorRef: null }] })
    .some((s) => s.item === 'D1.deposit'));
  const anchor = sourcesOf('pre-reset/d1/balance-check-2026-11-26T10-00-00-000Z.json', balanceFixture);
  const r = resolve([...ds, ...anchor], EMPTY_MANUAL);
  assert.equal(r.get('D1.deposit')!.primary!.hashes[0].hash, h(3));
  assert.equal(r.get('D1.deposit')!.primary!.anchorRef, 'r1');
  assert.ok(ALL_D1.every((id) => r.get(id)!.primary!.account === G1));

  const { root, sources } = goodFixture();
  const unlinked = sources.map((s) => (s.item === 'D1.deposit' ? { ...s, anchorRef: undefined } : s));
  assert.deepEqual(checkItems(resolve(unlinked, EMPTY_MANUAL), root), [`D1.deposit: ${h(100)} is not linked to an anchor transaction (no anchor ref)`]);
});

test('EV12 archive-tx --from-md: hashes inside the generated month-2 block are not month 1', () => {
  const md = `# Evidence\n\n[tx](https://stellar.expert/explorer/testnet/tx/${h(1)})\n\n${BLOCK_START}\n[a](https://stellar.expert/explorer/testnet/tx/${h(2)}) ${h(3)}\n${BLOCK_END}\n\nafter ${h(4)}\n`;
  assert.deepEqual(hashesOutsideBlock(md), [h(1), h(4)]);
  assert.deepEqual(hashesOutsideBlock(`plain ${h(5)}`), [h(5)]);
});

test('EV13 no script prints an anchor more_info_url raw (its token does not expire): console lines go through stripToken', () => {
  const offenders: string[] = [];
  for (const f of readdirSync('scripts').filter((n) => n.endsWith('.ts'))) {
    readFileSync(join('scripts', f), 'utf8').split('\n').forEach((line, i) => {
      if (/console\.(log|error|warn|info)/.test(line) && /\$\{[^}]*(moreInfoUrl|more_info_url)[^}]*\}/.test(line)
        && !/\$\{stripToken\([^}]*(moreInfoUrl|more_info_url)/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('EV14 after the reset the archived D1 sources are the pre-reset one-sender group archive-tx archived, not the newest per item (C5-1)', () => {
  const pre = d1('pre-reset/d1/group', G1, '2026-11-25', ALL_D1).map((x) => ({ ...x, phase: 'pre-reset' as const }));
  // newer partial pre-reset runs from another sender: the newest source for two items, but not one group
  const partial = d1('pre-reset/d1/partial', G2, '2026-11-28', ['D1.deposit', 'D1.send.PHP'])
    .map((x) => ({ ...x, hashes: [{ label: 'x', hash: h(900 + x.item.length) }] }));
  const post = d1('post-reset/d1/group', G1, '2026-12-20', ALL_D1).map((x) => ({ ...x, phase: 'post-reset' as const, hashes: [{ label: 'x', hash: h(500 + x.item.length) }] }));
  const all = [...pre, ...partial, ...post];
  const r = resolve(all, EMPTY_MANUAL);
  assert.ok(ALL_D1.every((id) => r.get(id)!.primary!.phase === 'post-reset'));
  assert.ok(ALL_D1.every((id) => r.get(id)!.archived!.file === 'pre-reset/d1/group'), 'archived = the pre-reset group');
  assert.equal(new Set(ALL_D1.map((id) => r.get(id)!.archived!.account)).size, 1);
  // every pre-reset hash EVIDENCE.md cites is one archive-tx --phase pre-reset archives
  const archivedPre = new Set(citedByPhase(resolve(all, EMPTY_MANUAL, 'pre-reset')).map((c) => c.hash));
  const citedPre = citedByPhase(r).filter((c) => c.phase === 'pre-reset').map((c) => c.hash);
  assert.ok(citedPre.length > 0 && citedPre.every((x) => archivedPre.has(x)));
});

test('EV15 archive-tx --refresh keeps a saved rpc copy when the RPC now answers NOT_FOUND (C5-4)', () => {
  assert.deepEqual(refreshedRpc({ status: 'SUCCESS' }, { status: 'NOT_FOUND' }), { rpc: { status: 'SUCCESS' }, kept: true });
  assert.deepEqual(refreshedRpc({ status: 'NOT_FOUND' }, { status: 'NOT_FOUND' }), { rpc: { status: 'NOT_FOUND' }, kept: false });
  assert.deepEqual(refreshedRpc(undefined, { status: 'NOT_FOUND' }), { rpc: { status: 'NOT_FOUND' }, kept: false });
  assert.deepEqual(refreshedRpc({ status: 'SUCCESS' }, { status: 'FAILED' }), { rpc: { status: 'FAILED' }, kept: false });
});

test('EV16 evidence-index --check: a pre-reset source written at or after the reset is reported (C6-1)', () => {
  const ok = src('D2.supply', { file: 'pre-reset/d2/pool-check-a.json', at: '2026-12-16T16:59:59.999Z' });
  const late = src('D2.withdraw', { file: 'pre-reset/d2/pool-check-b.json', at: '2026-12-16T17:00:00.000Z' });
  const post = src('D2.withdraw', { phase: 'post-reset', file: 'post-reset/d2/pool-check-c.json', at: '2026-12-20T00:00:00.000Z' });
  assert.deepEqual(lateSources([ok, late, post, src('D1.history', { file: 'manual.json', at: '' })]),
    ['D2.withdraw: pre-reset/d2/pool-check-b.json is pre-reset evidence written at 2026-12-16T17:00:00.000Z, after the testnet reset (2026-12-16T17:00:00.000Z); move it to post-reset/']);
});
