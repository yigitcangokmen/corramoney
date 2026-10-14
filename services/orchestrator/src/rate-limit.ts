/**
 * Fixed-window counters kept in memory. One orchestrator process serves the demo, so this is
 * enough; several processes would need a shared store.
 */
export function createLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Counts one hit for `key`; false once the window's budget is spent. */
    take(key: string): boolean {
      const t = now();
      const cur = hits.get(key);
      if (!cur || t >= cur.resetAt) {
        hits.set(key, { count: 1, resetAt: t + windowMs });
        if (hits.size > 10_000) for (const [k, v] of hits) if (t >= v.resetAt) hits.delete(k);
        return true;
      }
      cur.count += 1;
      return cur.count <= max;
    },
  };
}
