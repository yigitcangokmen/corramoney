import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { blendState, childPhase, exitCode, poolStatus, recordedPoolLives, runs, settle, waitMinutes } from './reset';

test('RS1 plan mode: 0 all done, 3 only Blend-blocked, 4 when any step is todo (an unbuilt testnet is not ready)', () => {
  assert.equal(exitCode(['done', 'done'], false), 0);
  assert.equal(exitCode(['done', 'blocked', 'blocked'], false), 3);
  assert.equal(exitCode(['todo', 'done'], false), 4);
  assert.equal(exitCode(['todo', 'blocked'], false), 4);
});

test('RS2 --run: a step left todo after running is a failure (2)', () => {
  assert.equal(exitCode(['done'], true), 0);
  assert.equal(exitCode(['done', 'blocked'], true), 3);
  assert.equal(exitCode(['todo', 'done'], true), 2);
});

test('RS3 blend is done only when the factory, the backstop and the oracle WASM are all live (C2-3)', () => {
  assert.equal(blendState({ factory: true, backstop: true, oracleWasm: true }).state, 'done');
  const noOracle = blendState({ factory: true, backstop: true, oracleWasm: false });
  assert.equal(noOracle.state, 'blocked');
  assert.match(noOracle.why, /oracle WASM/);
  assert.equal(blendState({ factory: false, backstop: true, oracleWasm: true }).state, 'blocked');
  assert.equal(blendState({ factory: true, backstop: false, oracleWasm: false }).state, 'blocked');
});

test('RS4 a throwing check is a failure, never todo, so its step never runs; exit 2 (S5-1)', async () => {
  let ran = 0;
  const st = await settle(async () => { throw new Error('RPC 503'); });
  assert.equal(st.state, 'failed');
  if (runs(st)) ran++;
  assert.equal(ran, 0);
  assert.equal(exitCode(['done', st.state], false), 2);
  assert.equal(exitCode(['blocked', st.state], true), 2);
});

test('RS5 pool: todo only with no pool or no instance; a live instance that fails or throws verify is failed (S5-1)', async () => {
  const live = async () => true;
  assert.equal((await poolStatus(null, { instanceLive: live, verify: async () => {} })).state, 'todo');
  assert.equal((await poolStatus('CPOOL', { instanceLive: async () => false, verify: async () => { throw new Error('x'); } })).state, 'todo');
  assert.equal((await poolStatus('CPOOL', { instanceLive: live, verify: async () => {} })).state, 'done');
  const flaky = await poolStatus('CPOOL', { instanceLive: live, verify: async () => { throw new Error('simulation failed: timeout'); } });
  assert.equal(flaky.state, 'failed');
  assert.match(flaky.why, /pool-check --verify-only/);
  assert.equal(runs(flaky), false);
  const down = await settle(() => poolStatus('CPOOL', { instanceLive: async () => { throw new Error('rpc down'); }, verify: async () => {} }));
  assert.equal(down.state, 'failed');
});

test('RS6 deploy-pool guard: false only for a missing instance or not the factory\'s pool; a flaky read rethrows (S5-1)', async () => {
  const ok = async () => true;
  assert.equal(await recordedPoolLives({ instanceLive: async () => false, isPool: ok, config: ok }), false);
  assert.equal(await recordedPoolLives({ instanceLive: ok, isPool: async () => false, config: ok }), false);
  assert.equal(await recordedPoolLives({ instanceLive: ok, isPool: ok, config: ok }), true);
  await assert.rejects(recordedPoolLives({ instanceLive: ok, isPool: async () => { throw new Error('RPC 503'); }, config: ok }), /RPC 503/);
  await assert.rejects(recordedPoolLives({ instanceLive: ok, isPool: ok, config: async () => { throw new Error('timeout'); } }), /timeout/);
});

test('RS7 after a reset the run steps write post-reset evidence; an explicit pre-reset is refused (C5-2)', () => {
  assert.equal(childPhase(undefined, true), 'post-reset');
  assert.equal(childPhase('', true), 'post-reset');
  assert.equal(childPhase(undefined, false), undefined);
  assert.equal(childPhase('post-reset', true), undefined);
  assert.throws(() => childPhase('pre-reset', true), /EVIDENCE_PHASE=pre-reset/);
});

test('RS8 --wait-blend needs a positive integer; the script exits 1 with the usage before any check runs (C6-4)', () => {
  assert.equal(waitMinutes(['--run']), 0);
  assert.equal(waitMinutes(['--run', '--wait-blend', '30']), 30);
  for (const bad of [['--wait-blend'], ['--wait-blend', 'x'], ['--wait-blend', '--run'], ['--wait-blend', '0'], ['--wait-blend', '-5'], ['--wait-blend', '2.5']]) {
    assert.throws(() => waitMinutes(bad), /usage: --wait-blend <minutes>/, bad.join(' '));
  }
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/redeploy-after-reset.ts', '--run', '--wait-blend'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: --wait-blend <minutes>/);
  assert.ok(!/blend|seed|anchor/i.test(r.stdout), 'no check ran');
});
