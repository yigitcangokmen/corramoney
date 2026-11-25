export type StepState = 'done' | 'todo' | 'blocked' | 'failed';
export type Status = { state: StepState; why: string };

/**
 * redeploy-after-reset's exit code from its step states: 0 all done; 2 any check failed; 3 all left
 * are waiting for Blend's factory; otherwise 4 in plan mode (work to do: the testnet is not rebuilt)
 * and 2 after --run.
 */
export function exitCode(states: StepState[], run: boolean): 0 | 2 | 3 | 4 {
  const left = states.filter((s) => s !== 'done');
  if (!left.length) return 0;
  if (left.includes('failed')) return 2;
  if (left.every((s) => s === 'blocked')) return 3;
  return run ? 2 : 4;
}

/**
 * The blend step: deploy-pool needs Blend's factory, its backstop and its oraclemock WASM; a reset
 * that brought back only some of them is still blocked (deploy-pool would fail on the missing one).
 */
export function blendState(live: { factory: boolean; backstop: boolean; oracleWasm: boolean }): { state: 'done' | 'blocked'; why: string } {
  if (!live.factory || !live.backstop) return { state: 'blocked', why: 'Blend has not redeployed its factory and backstop yet' };
  if (!live.oracleWasm) return { state: 'blocked', why: 'Blend has not re-uploaded its oracle WASM yet' };
  return { state: 'done', why: 'factory, backstop and oracle WASM live' };
}

/**
 * A step's check, where a check that throws (a flaky RPC or Horizon read) is a failure, never todo:
 * todo means "run the step", and a step must never run on a read that did not answer (S5-1).
 */
export async function settle(check: () => Promise<Status>): Promise<Status> {
  try {
    return await check();
  } catch (e) {
    return { state: 'failed', why: `check failed: ${(e as Error).message}` };
  }
}

/** Only a todo step runs. */
export const runs = (st: Status) => st.state === 'todo';

/**
 * The pool step. todo only when no pool is recorded or the recorded pool's contract instance is
 * absent (a reset); an instance that exists but does not verify, or a verify that throws, is a
 * failure: --run must never let deploy-pool replace a pool that may hold deposits (J-u6-9).
 */
export async function poolStatus(pool: string | null, deps: { instanceLive: () => Promise<boolean>; verify: () => Promise<unknown> }): Promise<Status> {
  if (!pool) return { state: 'todo', why: 'no pool recorded' };
  if (!(await deps.instanceLive())) return { state: 'todo', why: `the recorded pool ${pool} has no contract instance on chain (a reset)` };
  try {
    await deps.verify();
    return { state: 'done', why: `${pool} verified` };
  } catch (e) {
    return { state: 'failed', why: `the recorded pool ${pool} is on chain but does not verify (${(e as Error).message}); `
      + 'run pnpm pool-check --verify-only and fix it by hand: --run never replaces a live pool' };
  }
}

/**
 * deploy-pool's guard: false only when the recorded pool's instance is absent or the factory says it
 * is not its pool; every other error (a flaky read) is rethrown so the J84 refusal and the strand
 * check are never skipped (S5-1).
 */
export async function recordedPoolLives(deps: { instanceLive: () => Promise<boolean>; isPool: () => Promise<unknown>; config: () => Promise<unknown> }) {
  if (!(await deps.instanceLive())) return false;
  if ((await deps.isPool()) !== true) return false;
  await deps.config();
  return true;
}

/**
 * EVIDENCE_PHASE for the run steps (deploy-pool, pool-check write evidence): an explicit value is
 * kept; unset after a detected reset it is post-reset, so the new pool's evidence never replaces the
 * pre-reset D2 files (C5-2). An explicit pre-reset on a reset testnet is refused.
 */
export function childPhase(env: string | undefined, reset: boolean): 'pre-reset' | 'post-reset' | undefined {
  if (reset && env === 'pre-reset') throw new Error('the testnet was reset but EVIDENCE_PHASE=pre-reset: unset it or export EVIDENCE_PHASE=post-reset');
  if (env) return undefined;
  return reset ? 'post-reset' : undefined;
}

/** --wait-blend <minutes>: absent 0; present it needs a positive integer, else 'usage: --wait-blend <minutes>' (C6-4). */
export function waitMinutes(args: string[]): number {
  if (!args.includes('--wait-blend')) return 0;
  const v = args[args.indexOf('--wait-blend') + 1];
  if (v === undefined || !/^[1-9]\d*$/.test(v)) throw new Error('usage: --wait-blend <minutes>');
  return Number(v);
}
