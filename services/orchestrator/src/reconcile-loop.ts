import { withTimeout } from '@corra/settlement-saga';

/**
 * Runs `pass` every `everyMs` and keeps every pass still in flight, not only the last one: a
 * reconciler that is already running answers a later tick at once, so the last tick alone can be
 * a settled no-op while the long pass still writes. `halt()` clears the timer, so no pass starts
 * after it; `stop()` halts and waits (up to `timeoutMs`) for every pass in flight, so the database
 * pool closes only after them.
 */
export function startReconcileLoop(pass: () => Promise<unknown>, everyMs: number) {
  const inFlight = new Set<Promise<unknown>>();
  const timer = setInterval(() => {
    const p: Promise<unknown> = pass().catch(() => {}).finally(() => inFlight.delete(p));
    inFlight.add(p);
  }, everyMs);
  return {
    halt() {
      clearInterval(timer);
    },
    async stop(timeoutMs = 15_000) {
      clearInterval(timer);
      await withTimeout(Promise.allSettled([...inFlight]), timeoutMs).catch(() => {});
    },
  };
}

/**
 * The shutdown order: halt the loop first (no pass starts while the HTTP server drains), close the
 * server, wait for the passes in flight, then end the database pool.
 */
export async function drainAndClose(loop: { halt(): void; stop(timeoutMs?: number): Promise<void> },
  closeApp: () => Promise<unknown>, endPool: () => Promise<unknown>, timeoutMs = 15_000) {
  loop.halt();
  await closeApp();
  await loop.stop(timeoutMs);
  await endPool();
}
