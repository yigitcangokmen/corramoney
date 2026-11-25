import { describe, expect, it } from 'vitest';
import { drainAndClose, startReconcileLoop } from './reconcile-loop';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('reconcile loop shutdown (J-u5-C2-4, C3-3)', () => {
  it('RL1 shutdown waits for a pass that outlasts two intervals before the pool closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const events: string[] = [];
    // Like the reconcilers: a pass while one runs returns 0 at once.
    let reconciling = false;
    const reconcile = async () => {
      if (reconciling) return 0;
      reconciling = true;
      try {
        events.push('start');
        await gate;
        events.push('write');
        return 1;
      } finally {
        reconciling = false;
      }
    };
    const loop = startReconcileLoop(() => Promise.allSettled([reconcile()]), 10);
    await sleep(45); // the first pass started at 10 ms; the ticks after it were settled no-ops
    expect(events).toEqual(['start']);

    const closed = loop.stop(5_000).then(() => events.push('pool.end'));
    await sleep(30);
    expect(events).toEqual(['start']); // still waiting for the gated pass
    release();
    await closed;
    expect(events).toEqual(['start', 'write', 'pool.end']);
  });

  it('RL2 stop gives up after its timeout, and no pass starts after stop', async () => {
    let passes = 0;
    const loop = startReconcileLoop(async () => { passes++; await new Promise(() => {}); }, 10);
    await sleep(25);
    const n = passes;
    const t0 = Date.now();
    await loop.stop(50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    await sleep(30);
    expect(passes).toBe(n);
  });

  it('RL3 shutdown halts the loop before the server closes: no pass starts during app.close() (C2-2)', async () => {
    const events: string[] = [];
    const loop = startReconcileLoop(async () => { events.push('pass'); }, 10);
    await sleep(25);
    events.length = 0;
    await drainAndClose(loop, async () => { events.push('close.start'); await sleep(60); events.push('close.end'); },
      async () => { events.push('pool.end'); });
    expect(events).toEqual(['close.start', 'close.end', 'pool.end']);
  });
});
