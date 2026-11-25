import pg from 'pg';

/**
 * A Pool whose client errors (Postgres restarted, connection killed) are logged, not fatal; queries
 * reconnect. pg re-emits an idle client's error on the Pool, and a checked-out client (a store
 * transaction) emits it on the client itself: either one unhandled ends the process. A client that
 * errored is not queryable, so pg-pool discards it when it is released.
 */
export function createDbPool(connectionString: string, onError: (e: Error) => void): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  // An idle client's error reaches both listeners: report it once.
  const seen = new WeakSet<Error>();
  const report = (e: Error) => {
    if (seen.has(e)) return;
    seen.add(e);
    onError(e);
  };
  pool.on('error', report);
  pool.on('connect', (client) => client.on('error', report));
  return pool;
}
