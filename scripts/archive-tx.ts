/**
 * Saves Horizon's JSON (transaction, operations, effects) for every evidence hash, and the RPC's
 * getTransaction for Soroban ones, so the evidence outlives the testnet reset (2026-12-16 17:00 UTC)
 * that wipes the history every stellar.expert link opens. Public chain data only. Stellar TESTNET.
 *
 *   pnpm archive-tx --from-md EVIDENCE.md                  month 1 -> evidence/2026-10/tx/ (the generated month-2 block is skipped)
 *   pnpm archive-tx [--phase pre-reset|post-reset] [--all] [--refresh]
 *
 * Without --from-md the hashes are the ones the month-2 items cite (scripts/lib/evidence.ts); --all
 * adds every 64-hex string in every run JSON of the phase. A 404 on a hash nothing cites (a memo, a
 * WASM hash, a salt) is listed under notFound; a cited 404 fails. Existing files are kept unless --refresh;
 * a refresh never replaces a saved RPC copy with the RPC's NOT_FOUND (past its retention window).
 * Exit 2: a pre-reset run finds a cited hash gone and Horizon behind the evidence (the reset happened).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TESTNET } from '../packages/shared/src';
import { citedByPhase, EVIDENCE_ROOT, evidenceDir, hashesIn, hashesOutsideBlock, PARTS, phaseOf, refreshedRpc, resolveItems, type Phase } from './lib/evidence';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const FROM_MD = opt('--from-md');
const ALL = args.includes('--all');
const REFRESH = args.includes('--refresh');
// Unset after the reset: phaseOf throws rather than archive into pre-reset/ (C6-1); --from-md has no phase.
const PHASE = (opt('--phase') ?? (FROM_MD ? undefined : phaseOf())) as Phase;
const HORIZON = TESTNET.horizonUrl;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string, code = 1): never {
  console.error(`archive-tx: ${message}`);
  process.exit(code);
}

/** Drops Horizon's `_links` at every depth. */
const unlinked = (v: any): any => (Array.isArray(v) ? v.map(unlinked)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_links').map(([k, x]) => [k, unlinked(x)])) : v);

/** GET with 3 tries; 404 -> null. */
async function get(url: string): Promise<any | null> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((e) => e as Error);
    if (!(r instanceof Error)) {
      if (r.status === 404) return null;
      if (r.ok) return r.json();
    }
    if (attempt >= 3) fail(`${url}: ${r instanceof Error ? r.message : `HTTP ${r.status}`} after 3 tries`);
    await sleep(1000 * attempt);
  }
}

async function rpcTransaction(hash: string) {
  const r = await fetch(TESTNET.rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: { hash } }), signal: AbortSignal.timeout(20_000),
  });
  const json: any = await r.json();
  if (json.error) throw new Error(`rpc getTransaction: ${json.error.message}`);
  return json.result?.status === 'NOT_FOUND' ? { status: 'NOT_FOUND' } : json.result;
}

type Wanted = { hash: string; source: string; cited: boolean };
type IndexRow = { hash: string; servedAs: string; sources: string[]; ledger: number; createdAt: string; successful: boolean; sourceAccount: string; feeAccount: string };

/** Hashes to archive, with where each came from. */
function wanted(): { dir: string; list: Wanted[]; highestLedger: number } {
  const map = new Map<string, Wanted>();
  const add = (hash: string, source: string, cited: boolean) => {
    const w = map.get(hash);
    if (w) {
      if (!w.source.split(', ').includes(source)) w.source += `, ${source}`;
      w.cited ||= cited;
    } else map.set(hash, { hash, source, cited });
  };
  if (FROM_MD) {
    // The generated month-2 block is not month 1: its hashes belong under evidence/2026-12/<phase>/tx.
    for (const hash of hashesOutsideBlock(readFileSync(FROM_MD, 'utf8'))) add(hash, FROM_MD, false);
    return { dir: 'evidence/2026-10/tx', list: [...map.values()], highestLedger: 0 };
  }
  if (PHASE !== 'pre-reset' && PHASE !== 'post-reset') fail('--phase must be pre-reset or post-reset');
  const r = resolveItems(PHASE);
  let highestLedger = 0;
  for (const c of citedByPhase(r)) if (c.phase === PHASE) add(c.hash, c.item, true);
  for (const v of r.values()) if (v.primary?.phase === PHASE) highestLedger = Math.max(highestLedger, v.primary.ledger ?? 0);
  if (ALL) {
    for (const part of PARTS) {
      const dir = `${EVIDENCE_ROOT}/${PHASE}/${part}`;
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        const json = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
        for (const { hash } of hashesIn(json)) add(hash, `${part}/${f}`, false);
      }
    }
  }
  return { dir: evidenceDir('tx', PHASE), list: [...map.values()], highestLedger };
}

async function main() {
  const { dir, list, highestLedger } = wanted();
  mkdirSync(dir, { recursive: true });
  const indexPath = `${dir}/index.json`;
  const prior: { archived: IndexRow[]; notFound: { hash: string; source: string }[] } =
    existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { archived: [], notFound: [] };
  console.log(`archive-tx: ${list.length} hashes -> ${dir} (Stellar testnet, ${HORIZON})`);

  const notFound = new Map(prior.notFound.map((n) => [n.hash, n]));
  const sources = new Map(prior.archived.map((a) => [a.hash, new Set(a.sources)]));
  let saved = 0;
  let kept = 0;
  const citedMissing: Wanted[] = [];
  for (const w of list) {
    const set = sources.get(w.hash) ?? new Set<string>();
    w.source.split(', ').forEach((s) => set.add(s));
    sources.set(w.hash, set);
    const path = `${dir}/${w.hash}.json`;
    if (existsSync(path) && !REFRESH) {
      kept++;
      continue;
    }
    await sleep(150);
    const transaction = await get(`${HORIZON}/transactions/${w.hash}`);
    if (!transaction) {
      sources.delete(w.hash);
      if (w.cited) citedMissing.push(w);
      else notFound.set(w.hash, { hash: w.hash, source: w.source });
      continue;
    }
    notFound.delete(w.hash);
    await sleep(150);
    const operations = (await get(`${HORIZON}/transactions/${w.hash}/operations?limit=200`))?._embedded?.records ?? [];
    await sleep(150);
    const effects = (await get(`${HORIZON}/transactions/${w.hash}/effects?limit=200`))?._embedded?.records ?? [];
    const servedAs = transaction.fee_bump_transaction
      ? (transaction.inner_transaction?.hash === w.hash && transaction.fee_bump_transaction.hash !== w.hash ? `inner of fee-bump ${transaction.fee_bump_transaction.hash}` : 'fee-bump')
      : 'transaction';
    const soroban = operations.some((o: any) => o.type === 'invoke_host_function');
    let rpc = soroban ? await rpcTransaction(w.hash) : undefined;
    if (rpc && existsSync(path)) {
      const kept = refreshedRpc(JSON.parse(readFileSync(path, 'utf8')).rpc, rpc);
      if (kept.kept) console.log(`  ${w.hash}: the RPC answers NOT_FOUND (past its retention); keeping the saved rpc copy (${kept.rpc.status})`);
      rpc = kept.rpc;
    }
    writeFileSync(path, JSON.stringify({
      hash: w.hash, servedAs, network: TESTNET.networkPassphrase, fetchedAt: new Date().toISOString(),
      horizon: { transaction: unlinked(transaction), operations: unlinked(operations), effects: unlinked(effects) },
      ...(rpc ? { rpc } : {}),
    }, null, 2) + '\n');
    saved++;
    console.log(`  ${w.hash} ledger ${transaction.ledger} ${servedAs}${rpc ? `, rpc ${rpc.status}` : ''}`);
  }

  if (citedMissing.length) {
    if (PHASE === 'pre-reset' && !FROM_MD) {
      const root = await get(`${HORIZON}/`);
      if (root && Number(root.core_latest_ledger) < highestLedger) {
        fail(`testnet was reset (Horizon at ledger ${root.core_latest_ledger}, the evidence reaches ${highestLedger}); `
          + 'the pre-reset archive had to be made before 2026-12-16 17:00 UTC', 2);
      }
    }
    for (const w of citedMissing) console.error(`  cited but not on Horizon: ${w.hash} (${w.source})`);
  }

  // The index covers every archived file in the folder, not only this run's.
  const archived: IndexRow[] = [];
  for (const f of readdirSync(dir).filter((x) => /^[0-9a-f]{64}\.json$/.test(x)).sort()) {
    const a = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    const t = a.horizon.transaction;
    archived.push({
      hash: a.hash, servedAs: a.servedAs, sources: [...(sources.get(a.hash) ?? [])].sort(), ledger: t.ledger, createdAt: t.created_at,
      successful: t.successful, sourceAccount: t.source_account, feeAccount: t.fee_account,
    });
  }
  writeFileSync(indexPath, JSON.stringify({ archived, notFound: [...notFound.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1)) }, null, 2) + '\n');
  console.log(`\n${saved} saved, ${kept} already archived, ${notFound.size} not found (uncited), ${citedMissing.length} cited missing; index ${indexPath}`);
  if (citedMissing.length) fail(`${citedMissing.length} cited hash(es) are not on Horizon`);
}

main().catch((e) => fail((e as Error).message));
