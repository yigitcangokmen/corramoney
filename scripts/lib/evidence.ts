/**
 * Month-2 evidence (second SOW): where the scripts write, what they may write, and the item model
 * that maps every SOW 6.1 line to the files and transactions that prove it. Stellar TESTNET only.
 *
 *   evidence/2026-12/<pre-reset|post-reset>/{d1,d2,d3,app,tx}/
 *
 * EVIDENCE_PHASE picks the phase (unset: pre-reset until the reset, an error after it). Every JSON carries its phase and origin
 * (prod: https://api.corra.money, local: localhost or no orchestrator). Nothing written here may
 * hold a `token=` query parameter or a secret seed: redact() strips the first and throws on the second.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, xdr } from '@stellar/stellar-sdk';
import { TESTNET, TESTNET_BLEND, TESTNET_CHANNELS } from '../../packages/shared/src';

export type Phase = 'pre-reset' | 'post-reset';
export type Part = 'd1' | 'd2' | 'd3' | 'app';
export type Origin = 'prod' | 'local' | 'other';
export const EVIDENCE_ROOT = 'evidence/2026-12';
export const PHASES: Phase[] = ['pre-reset', 'post-reset'];
export const PARTS: Part[] = ['d1', 'd2', 'd3', 'app'];
export const PROD_ORCHESTRATOR = 'https://api.corra.money';
/** The factory the SOW names; Blend redeploys it after a testnet reset. */
export const SOW_FACTORY = 'CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6';
/**
 * A secret seed's shape, standing alone: no letter or digit on either side, so it is not a run inside
 * a longer word or base64 (an XDR's zero bytes read "AAAA..."), but it is found in a URL path
 * (`/keys/S...`), after `+` and before `/` or `=` (C6-2).
 */
export const SEED = /(?<![A-Za-z0-9])S[A-Z2-7]{55}(?![A-Za-z0-9])/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** SDF's testnet reset (docs/testnet-reset.md): evidence written after it is post-reset. */
export const RESET_AT = '2026-12-16T17:00:00.000Z';

/**
 * EVIDENCE_PHASE; unset, 'pre-reset' before RESET_AT and an error from then on (a fresh shell after the
 * reset must not write into pre-reset/, C6-1). Anything else throws "EVIDENCE_PHASE must be pre-reset or post-reset".
 */
export function phaseOf(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Phase {
  const v = env.EVIDENCE_PHASE;
  if (v === undefined || v === '') {
    if (now.getTime() >= Date.parse(RESET_AT)) throw new Error('the testnet was reset: set EVIDENCE_PHASE=post-reset (or pre-reset explicitly)');
    return 'pre-reset';
  }
  if (v !== 'pre-reset' && v !== 'post-reset') throw new Error('EVIDENCE_PHASE must be pre-reset or post-reset');
  return v;
}

export function evidenceDir(part: Part | 'tx', phase: Phase = phaseOf()): string {
  return `${EVIDENCE_ROOT}/${phase}/${part}`;
}

/** https://api.corra.money -> prod; undefined, http://localhost*, http://127.0.0.1* -> local; else other. */
export function originOf(orchestratorUrl?: string): Origin {
  if (!orchestratorUrl) return 'local';
  const u = orchestratorUrl.replace(/\/+$/, '');
  if (u === PROD_ORCHESTRATOR) return 'prod';
  if (/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(u)) return 'local';
  return 'other';
}

/** A URL or HTML text without its `token` query parameters (`?token=`, `&token=`, `&amp;token=`). */
export function stripToken(s: string): string {
  return s.replace(/(\?|&(?:amp;)?)token=[^&#\s"'<>]*(&(?:amp;)?)?/g, (_m, pre: string, next?: string) =>
    (pre === '?' ? (next ? '?' : '') : (next ?? '')));
}

/** Deep copy; removes every `token` query parameter (`?token=` and `&token=`); throws on a seed-shaped string. bigint -> string. */
export function redact<T>(obj: T): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') {
      if (SEED.test(v)) throw new Error('refusing to write evidence: a value is shaped like a secret seed');
      return stripToken(v);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Writes `${evidenceDir(part)}/${name}-${iso}.json` = { phase, origin, orchestrator, writtenAt, ...redact(obj) }; returns the path. */
export function writeEvidence(part: Part, name: string, obj: object, orchestratorUrl = process.env.ORCHESTRATOR_URL): string {
  const phase = phaseOf();
  const dir = evidenceDir(part, phase);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}-${stamp()}.json`;
  const body = { phase, origin: originOf(orchestratorUrl), orchestrator: orchestratorUrl ?? null, writtenAt: new Date().toISOString(), ...(redact(obj) as object) };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  console.log(`wrote ${path}`);
  return path;
}

/** A text file (an anchor page) under `part`, token removed; returns the path. */
export function writeEvidenceText(part: Part, fileName: string, text: string): string {
  if (SEED.test(text)) throw new Error('refusing to write evidence: the text holds a seed-shaped string');
  const dir = evidenceDir(part);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${fileName}`;
  writeFileSync(path, stripToken(text));
  console.log(`wrote ${path}`);
  return path;
}

/** Every /^[0-9a-f]{64}$/ string value at any depth, with its JSON path. */
export function hashesIn(obj: unknown): { hash: string; path: string }[] {
  const out: { hash: string; path: string }[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (HASH.test(v)) out.push({ hash: v, path });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  };
  walk(obj, '');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Item model: SOW 6.1 lines -> sources (run files and manual entries) -> one primary per item.

export type ItemId = 'D1.deposit' | 'D1.send.PHP' | 'D1.send.BRL' | 'D1.send.ARS' | 'D1.send.IDR' | 'D1.send.THB'
  | 'D1.history' | 'D1.hosted' | 'D2.contract' | 'D2.supply' | 'D2.withdraw' | 'D2.position'
  | 'D3.withdrawal' | 'D3.anchorPage' | 'D3.setups' | 'D3.ci' | 'video';

export type Source = {
  item: ItemId; phase: Phase; origin: Origin | 'freighter'; file: string; at: string;
  hashes: { label: string; hash: string }[]; links: { label: string; url: string }[]; files: string[]; note?: string;
  /** The sender, supplier or recipient the claim is about (D1 groups by it). */
  account?: string;
  ledger?: number;
  /** D1.deposit only: the anchor transaction the deposit was matched to (by ref or the signed callback). */
  anchorRef?: string;
};

/** SOW 6.1, split into the lines a reviewer checks. */
export const ITEMS: { id: ItemId; deliverable: 0 | 1 | 2 | 3; sow: string }[] = [
  { id: 'D1.deposit', deliverable: 1, sow: "A deposit into a sender's own account that is not tied to any payment" },
  { id: 'D1.send.PHP', deliverable: 1, sow: 'A send from that balance to the Philippines (TESTPHP)' },
  { id: 'D1.send.BRL', deliverable: 1, sow: 'A send from that balance to Brazil (TESTBRL)' },
  { id: 'D1.send.ARS', deliverable: 1, sow: 'A send from that balance to Argentina (TESTARS)' },
  { id: 'D1.send.IDR', deliverable: 1, sow: 'A send from that balance to Indonesia (TESTIDR)' },
  { id: 'D1.send.THB', deliverable: 1, sow: 'A send from that balance to Thailand (TESTTHB)' },
  { id: 'D1.history', deliverable: 1, sow: "The app's History showing the deposit linked to the anchor's transaction" },
  { id: 'D1.hosted', deliverable: 1, sow: 'The same flow on https://app.corra.money' },
  { id: 'D2.contract', deliverable: 2, sow: 'The pool contract on stellar.expert' },
  { id: 'D2.supply', deliverable: 2, sow: "A deposit into the pool, signed by the sender's account and fee-bumped" },
  { id: 'D2.withdraw', deliverable: 2, sow: "A withdrawal from the pool, signed by the sender's account and fee-bumped" },
  { id: 'D2.position', deliverable: 2, sow: 'A screenshot of the position and the 0% rate with the On-Ice note' },
  { id: 'D3.withdrawal', deliverable: 3, sow: "The recipient's withdrawal payment to the anchor's distribution account" },
  { id: 'D3.anchorPage', deliverable: 3, sow: "The anchor's transaction page showing it completed" },
  { id: 'D3.setups', deliverable: 3, sow: 'Three sponsored setups in the same ledger, each with a different channel account as source' },
  { id: 'D3.ci', deliverable: 3, sow: 'A green run of the extended no-server-side-signing job' },
  { id: 'video', deliverable: 0, sow: 'One walkthrough video covering all three deliverables' },
];
const ITEM_IDS = new Set(ITEMS.map((i) => i.id));
const SENDS = ['PHP', 'BRL', 'ARS', 'IDR', 'THB'] as const;
const D1_GROUP: ItemId[] = ['D1.deposit', ...SENDS.map((f) => `D1.send.${f}` as ItemId)];
/** Items the builder supplies (a deploy, CI, the video): pending is allowed until --final. */
export const BUILDER_ITEMS: ItemId[] = ['D1.hosted', 'D3.ci', 'video'];

export type ManualItem = {
  item: ItemId; phase: Phase; origin: Origin | 'freighter'; files?: string[]; links?: { label: string; url: string }[];
  hashes?: { label: string; hash: string }[]; note?: string; at?: string; account?: string;
};
export type Manual = {
  items: ManualItem[]; pins: Partial<Record<ItemId, string>>; notes: { reset: string; blend: string }; deviations: string[];
};

export const EMPTY_MANUAL: Manual = { items: [], pins: {}, notes: { reset: '', blend: '' }, deviations: [] };

/** manual.json, refusing unknown keys and item ids. */
export function validateManual(x: unknown): Manual {
  const bad = (why: string): never => { throw new Error(`manual.json: ${why}`); };
  const obj = (v: unknown, what: string) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(`${what} must be an object`));
  const keys = (o: Record<string, unknown>, allowed: string[], what: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`unknown key ${what}.${k}`);
  };
  const strs = (v: unknown, what: string) => (Array.isArray(v) && v.every((s) => typeof s === 'string') ? v as string[] : bad(`${what} must be a list of strings`));
  const pairs = (v: unknown, what: string, field: 'url' | 'hash') => {
    if (!Array.isArray(v)) bad(`${what} must be a list`);
    return (v as unknown[]).map((p, i) => {
      const o = obj(p, `${what}[${i}]`);
      keys(o, ['label', field], `${what}[${i}]`);
      if (typeof o.label !== 'string' || typeof o[field] !== 'string') bad(`${what}[${i}] needs label and ${field}`);
      if (field === 'hash' && !HASH.test(o.hash as string)) bad(`${what}[${i}].hash is not a 64-hex transaction hash`);
      return { label: o.label as string, [field]: o[field] as string };
    });
  };
  const m = obj(x, 'manual');
  keys(m, ['items', 'pins', 'notes', 'deviations'], 'manual');
  if (!Array.isArray(m.items)) bad('items must be a list');
  const items = (m.items as unknown[]).map((raw, i): ManualItem => {
    const o = obj(raw, `items[${i}]`);
    keys(o, ['item', 'phase', 'origin', 'files', 'links', 'hashes', 'note', 'at', 'account'], `items[${i}]`);
    if (!ITEM_IDS.has(o.item as ItemId)) bad(`items[${i}].item ${JSON.stringify(o.item)} is not an item id`);
    if (!PHASES.includes(o.phase as Phase)) bad(`items[${i}].phase must be pre-reset or post-reset`);
    if (!['freighter', 'prod', 'local', 'other'].includes(o.origin as string)) bad(`items[${i}].origin must be freighter, prod, local or other`);
    for (const k of ['note', 'at', 'account'] as const) if (o[k] !== undefined && typeof o[k] !== 'string') bad(`items[${i}].${k} must be a string`);
    // The walkthrough video is submitted privately: EVIDENCE.md is public, so no link, file or hash for it (S5-2, J-u6-40).
    if (o.item === 'video') {
      for (const k of ['links', 'files', 'hashes'] as const) if (o[k] !== undefined) bad(`items[${i}] video takes only a note: the video link is submitted privately, never published (no ${k})`);
      if (typeof o.note === 'string' && /https?:\/\/|www\./i.test(o.note)) bad(`items[${i}] video note must not hold a link: the video link is submitted privately`);
    }
    return {
      item: o.item as ItemId, phase: o.phase as Phase, origin: o.origin as ManualItem['origin'],
      ...(o.files !== undefined ? { files: strs(o.files, `items[${i}].files`) } : {}),
      ...(o.links !== undefined ? { links: pairs(o.links, `items[${i}].links`, 'url') as ManualItem['links'] } : {}),
      ...(o.hashes !== undefined ? { hashes: pairs(o.hashes, `items[${i}].hashes`, 'hash') as ManualItem['hashes'] } : {}),
      ...(o.note !== undefined ? { note: o.note as string } : {}),
      ...(o.at !== undefined ? { at: o.at as string } : {}),
      ...(o.account !== undefined ? { account: o.account as string } : {}),
    };
  });
  const pins = obj(m.pins ?? {}, 'pins');
  for (const [k, v] of Object.entries(pins)) {
    if (!ITEM_IDS.has(k as ItemId)) bad(`pins.${k} is not an item id`);
    if (typeof v !== 'string') bad(`pins.${k} must be a file path`);
  }
  const notes = obj(m.notes ?? { reset: '', blend: '' }, 'notes');
  keys(notes, ['reset', 'blend'], 'notes');
  for (const k of ['reset', 'blend'] as const) if (notes[k] !== undefined && typeof notes[k] !== 'string') bad(`notes.${k} must be a string`);
  return {
    items, pins: pins as Manual['pins'], notes: { reset: (notes.reset as string) ?? '', blend: (notes.blend as string) ?? '' },
    deviations: m.deviations === undefined ? [] : strs(m.deviations, 'deviations'),
  };
}

export function manualSources(manual: Manual): Source[] {
  return manual.items.map((m) => ({
    item: m.item, phase: m.phase, origin: m.origin, file: 'manual.json', at: m.at ?? '',
    hashes: m.hashes ?? [], links: m.links ?? [], files: m.files ?? [],
    ...(m.note ? { note: m.note } : {}), ...(m.account ? { account: m.account } : {}),
  }));
}

const FIAT_OF_CODE: Record<string, (typeof SENDS)[number]> = { TESTPHP: 'PHP', TESTBRL: 'BRL', TESTARS: 'ARS', TESTIDR: 'IDR', TESTTHB: 'THB' };
const contractUrl = (c: string) => `https://stellar.expert/explorer/testnet/contract/${c}`;
export const txUrl = (h: string) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const isHash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);
const isPng = (f: string) => /\.png$/i.test(f);
/** A deposit row linked to the anchor's transaction: an anchor ref, matched by it or by the signed callback (not by chain alone). */
const anchored = (d: any) => typeof d?.anchorRef === 'string' && d.anchorRef !== '' && (d.matchedBy === 'ref' || d.matchedBy === 'callback_tx');

/**
 * The sources one run file gives, by its name prefix. `file` is relative to EVIDENCE_ROOT
 * (`<phase>/<part>/<name>`); a JSON without `origin` reads as local.
 */
export function sourcesOf(file: string, json: unknown): Source[] {
  const j = (json ?? {}) as any;
  const phase: Phase = PHASES.includes(j.phase) ? j.phase : file.startsWith('post-reset/') ? 'post-reset' : 'pre-reset';
  const origin: Origin = ['prod', 'local', 'other'].includes(j.origin) ? j.origin : 'local';
  const name = file.split('/').pop() ?? '';
  const at = typeof j.writtenAt === 'string' ? j.writtenAt : stampOf(name);
  const base = { phase, origin, file, at, links: [] as Source['links'], files: [] as string[] };
  const out: Source[] = [];
  const add = (s: Omit<Source, 'phase' | 'origin' | 'file' | 'at' | 'links' | 'files'> & Partial<Source>) => {
    if (s.hashes.every((h) => isHash(h.hash))) out.push({ ...base, ...s });
  };

  if (name.startsWith('balance-check-')) {
    // SOW 6.1 D1 needs the deposit linked to the anchor's transaction: a DEPOSIT=direct run proves the sends only.
    if (j.deposit !== 'direct' && j.depositRow?.status === 'CONFIRMED' && isHash(j.depositRow.txHash) && anchored(j.depositRow)) {
      add({ item: 'D1.deposit', account: j.sender, anchorRef: j.depositRow.anchorRef, hashes: [{ label: 'deposit', hash: j.depositRow.txHash }],
        note: `${j.depositRow.id}, matched by ${j.depositRow.matchedBy}, anchor ref ${j.depositRow.anchorRef}` });
    }
    for (const s of j.sends ?? []) {
      if (s.state === 'CREDITED' && SENDS.includes(s.fiat)) {
        add({ item: `D1.send.${s.fiat}` as ItemId, account: j.sender, ledger: s.ledger, hashes: [{ label: s.publicId ?? 'payment', hash: s.txHash }],
          note: `${s.dest}` });
      }
    }
  } else if (name.startsWith('app-run-')) {
    const dep = (j.deposits ?? []).find((d: any) => d.status === 'CONFIRMED' && isHash(d.txHash) && anchored(d));
    if (dep) add({ item: 'D1.deposit', account: j.account, anchorRef: dep.anchorRef, hashes: [{ label: 'deposit', hash: dep.txHash }], note: `${dep.id}, anchor ref ${dep.anchorRef}` });
    const seen = new Set<string>();
    for (const p of j.payments ?? []) {
      const fiat = FIAT_OF_CODE[p.destAsset];
      if (p.kind !== 'balance' || p.state !== 'CREDITED' || !fiat || seen.has(fiat)) continue;
      seen.add(fiat);
      add({ item: `D1.send.${fiat}` as ItemId, account: j.account, ledger: p.ledger, hashes: [{ label: p.publicId ?? 'payment', hash: p.txHash }],
        note: `${p.destAmount} ${p.destAsset}` });
    }
    // Only a run the builder marked --via-app (done in the app on app.corra.money) is the hosted flow; a
    // script on api.corra.money is not (S3-3). Otherwise D1.hosted comes from manual.json with a screenshot.
    if (origin === 'prod' && j.viaApp === true && dep && seen.size) {
      out.push({ ...base, item: 'D1.hosted', account: j.account, hashes: [], links: [{ label: 'app.corra.money', url: 'https://app.corra.money' }],
        note: `deposit and ${seen.size} send(s) through https://app.corra.money` });
    }
    for (const kind of ['supply', 'withdraw'] as const) {
      const op = (j.pool?.ops ?? []).find((o: any) => o.kind === kind && o.status === 'SUCCESS');
      if (op) add({ item: kind === 'supply' ? 'D2.supply' : 'D2.withdraw', account: j.account, ledger: op.ledger,
        hashes: [{ label: 'fee-bump', hash: op.txHash }, { label: 'inner', hash: op.innerHash }] });
    }
    const co = (j.cashOuts ?? []).find((c: any) => c.status === 'CONFIRMED' && isHash(c.txHash));
    if (co) add({ item: 'D3.withdrawal', account: j.recipient, ledger: co.ledger, hashes: [{ label: 'withdrawal', hash: co.txHash }] });
  } else if (name.startsWith('deploy-pool-') || name.startsWith('pool-verify-')) {
    const ids = j.ids ?? {};
    if (typeof ids.pool === 'string') {
      add({ item: 'D2.contract', ledger: j.ledger, links: [{ label: 'pool', url: contractUrl(ids.pool) }],
        hashes: (j.steps ?? []).filter((s: any) => isHash(s.hash)).map((s: any) => ({ label: s.label, hash: s.hash })),
        note: name.startsWith('deploy-pool-') ? 'deployed through the factory' : `verified: status ${j.status ?? '?'}, admin ${ids.admin ?? '?'}` });
    }
  } else if (name.startsWith('pool-check-')) {
    for (const kind of ['supply', 'withdraw'] as const) {
      const o = j[kind];
      if (o && isHash(o.outer) && isHash(o.inner)) {
        add({ item: kind === 'supply' ? 'D2.supply' : 'D2.withdraw', account: j.account, ledger: o.ledger,
          hashes: [{ label: 'fee-bump', hash: o.outer }, { label: 'inner', hash: o.inner }] });
      }
    }
  } else if (name.startsWith('cash-out-')) {
    const w = j.withdrawal ?? {};
    if (isHash(w.envelope)) {
      add({ item: 'D3.withdrawal', account: j.recipient, ledger: w.ledger,
        hashes: [{ label: 'fee-bump', hash: w.envelope }, ...(isHash(w.inner) ? [{ label: 'inner', hash: w.inner }] : [])] });
    }
    if (j.anchor?.status === 'completed' && typeof j.anchor.id === 'string') {
      const html = `${file.slice(0, file.lastIndexOf('/'))}/more-info-${j.anchor.id}.html`;
      add({ item: 'D3.anchorPage', hashes: [], files: typeof j.moreInfoHtml === 'string' ? [j.moreInfoHtml] : [],
        note: `anchor ${j.anchor.id} completed, payout ${j.anchor.payout}${typeof j.moreInfoHtml === 'string' ? '' : ` (no saved page; expected ${html})`}` });
    }
  } else if (name.startsWith('concurrent-setups-')) {
    const users = j.users ?? [];
    if (users.length === 3) {
      add({ item: 'D3.setups', ledger: j.ledger, hashes: users.map((u: any, i: number) => ({ label: `setup ${i + 1}`, hash: u.accountTx })),
        note: `three setups in ledger ${j.ledger}` });
    }
  }
  return out;
}

/** 2026-11-25T08-23-40-273Z -> 2026-11-25T08:23:40.273Z, from a file name. */
function stampOf(name: string): string {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : '';
}

const ORIGIN_RANK = { freighter: 0, prod: 1, local: 2, other: 3 } as const;
/** post-reset before pre-reset; then freighter > prod > local > other; then newest. */
const better = (a: Source, b: Source) =>
  (a.phase === b.phase ? 0 : a.phase === 'post-reset' ? -1 : 1)
  || ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]
  || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)
  || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

export type Resolved = Map<ItemId, { primary: Source | null; archived: Source | null; warning?: string }>;

/** Pure selection over `sources` (see the module comment); `phase` keeps only that phase's sources. */
export function resolve(all: Source[], manual: Manual, phase?: Phase): Resolved {
  const sources = phase ? all.filter((s) => s.phase === phase) : all;
  const of = (id: ItemId) => sources.filter((s) => s.item === id).sort(better);
  const pinned = (id: ItemId) => {
    const pin = manual.pins[id];
    return pin ? sources.find((s) => s.item === id && s.file === pin) ?? null : null;
  };
  const r: Resolved = new Map();
  for (const { id } of ITEMS) r.set(id, { primary: pinned(id) ?? of(id)[0] ?? null, archived: null });

  // D1 is one sender's deposit plus five sends.
  const d1 = sources.filter((s) => D1_GROUP.includes(s.item) && s.account);
  const complete = (group: Source[]) => D1_GROUP.every((id) => group.some((s) => s.item === id));
  const byFile = new Map<string, Source[]>();
  for (const s of d1) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  const whole = [...byFile.values()].filter((g) => complete(g) && new Set(g.map((s) => s.account)).size === 1)
    .sort((a, b) => better(a[0], b[0]));
  let group: Source[] | null = whole[0] ?? null;
  let warning: string | undefined;
  if (!group) {
    const byAccount = new Map<string, Source[]>();
    for (const s of d1) byAccount.set(s.account!, [...(byAccount.get(s.account!) ?? []), s]);
    const assembled = [...byAccount.values()].filter(complete)
      .map((g) => D1_GROUP.map((id) => g.filter((s) => s.item === id).sort(better)[0]))
      .sort((a, b) => {
        const newest = (g: Source[]) => g.map((s) => s.at).sort().at(-1) ?? '';
        const phaseRank = (g: Source[]) => (g.every((s) => s.phase === 'post-reset') ? 0 : 1);
        return phaseRank(a) - phaseRank(b) || (newest(a) < newest(b) ? 1 : newest(a) > newest(b) ? -1 : 0);
      });
    if (assembled[0]) {
      group = assembled[0];
      warning = `assembled from ${new Set(group.map((s) => s.file)).size} runs`;
    }
  }
  if (group) {
    for (const id of D1_GROUP) {
      r.set(id, { primary: pinned(id) ?? group.find((s) => s.item === id)!, archived: null, ...(warning ? { warning } : {}) });
    }
  }

  // A post-reset primary keeps the pre-reset resolution's primary as the archived one: the same D1
  // one-sender group and pins archive-tx --phase pre-reset archived, not the newest source per item (C5-1).
  if ([...r.values()].some((v) => v.primary?.phase === 'post-reset')) {
    const pre = resolve(all, manual, 'pre-reset');
    for (const [id, v] of r) if (v.primary?.phase === 'post-reset') v.archived = pre.get(id)?.primary ?? null;
  }
  return r;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

export function readManual(root = EVIDENCE_ROOT): Manual {
  const path = `${root}/manual.json`;
  return existsSync(path) ? validateManual(JSON.parse(readFileSync(path, 'utf8'))) : EMPTY_MANUAL;
}

/** Every source on disk: the run JSONs under <phase>/{d1,d2,d3,app} plus manual.json. */
export function sourcesOnDisk(root = EVIDENCE_ROOT): Source[] {
  const out: Source[] = [];
  for (const phase of PHASES) {
    for (const part of PARTS) {
      for (const f of listFiles(`${root}/${phase}/${part}`).filter((x) => x.endsWith('.json')).sort()) {
        out.push(...sourcesOf(f.slice(root.length + 1), JSON.parse(readFileSync(f, 'utf8'))));
      }
    }
  }
  return [...out, ...manualSources(readManual(root))];
}

export function resolveItems(phase?: Phase, root = EVIDENCE_ROOT): Resolved {
  return resolve(sourcesOnDisk(root), readManual(root), phase);
}

/** The hashes the primaries (and archived sources) cite, each once. */
export function citedHashes(r: Resolved): string[] {
  const out = new Set<string>();
  for (const v of r.values()) for (const s of [v.primary, v.archived]) for (const h of s?.hashes ?? []) out.add(h.hash);
  return [...out];
}

/** The phase each cited hash is archived under. */
export function citedByPhase(r: Resolved): { hash: string; phase: Phase; item: ItemId }[] {
  const out = new Map<string, { hash: string; phase: Phase; item: ItemId }>();
  for (const [item, v] of r) for (const s of [v.primary, v.archived]) for (const h of s?.hashes ?? []) out.set(`${s!.phase}/${h.hash}`, { hash: h.hash, phase: s!.phase, item });
  return [...out.values()];
}

/**
 * archive-tx --refresh: the RPC keeps Soroban transactions only for a short window, so a NOT_FOUND
 * answer never replaces a saved copy with another status (evidence/ is untracked: it could not be
 * recovered) (C5-4).
 */
export function refreshedRpc<T extends { status?: string }>(prior: T | undefined, fresh: T | undefined): { rpc: T | undefined; kept: boolean } {
  if (fresh?.status === 'NOT_FOUND' && prior?.status && prior.status !== 'NOT_FOUND') return { rpc: prior, kept: true };
  return { rpc: fresh, kept: false };
}

// ---------------------------------------------------------------------------------------------
// EVIDENCE.md block

export const BLOCK_START = '<!-- evidence-index:start -->';
export const BLOCK_END = '<!-- evidence-index:end -->';
export const MONTH2_HEADING = '## Month 2: balance, Blend pool, cash-out (second SOW)';

const code = (s: string) => `\`${s}\``;
const short = (h: string) => `${h.slice(0, 8)}...${h.slice(-4)}`;

function evidenceCell(s: Source): string {
  const parts: string[] = [];
  for (const h of s.hashes) parts.push(`[${h.label} ${short(h.hash)}](${txUrl(h.hash)})`);
  if (s.ledger) parts.push(`ledger ${s.ledger}`);
  for (const l of s.links) parts.push(`[${l.label}](${l.url})`);
  for (const f of s.files) parts.push(`[${f.split('/').pop()}](${EVIDENCE_ROOT}/${f})`);
  if (s.note) parts.push(s.note);
  parts.push(`${s.origin === 'freighter' ? 'Freighter' : s.origin === 'prod' ? 'through api.corra.money' : s.origin === 'local' ? 'local stack' : 'other host'}, ${s.phase}`);
  return parts.join('; ').replace(/\|/g, '\\|');
}

function archiveCell(s: Source): string {
  const parts = s.file === 'manual.json' ? [] : [`[run](${EVIDENCE_ROOT}/${s.file})`];
  for (const h of s.hashes) parts.push(`[tx ${h.hash.slice(0, 8)}](${EVIDENCE_ROOT}/${s.phase}/tx/${h.hash}.json)`);
  return parts.join(', ') || '-';
}

/** The generated block, markers included. Deterministic: no clock, sources in a fixed order. */
export function renderBlock(r: Resolved, manual: Manual): string {
  const L: string[] = [BLOCK_START, '', '_Generated by `pnpm evidence-index` from `evidence/2026-12/`; edit `evidence/2026-12/manual.json`, not this block._', ''];
  L.push(`**Testnet reset.** ${manual.notes.reset || 'SDF resets Stellar testnet on 2026-12-16 17:00 UTC. Every transaction cited before then is archived as Horizon JSON under `evidence/2026-12/pre-reset/tx/` (month 1 under `evidence/2026-10/tx/`), because the reset deletes the history the links open. The rebuild reuses every team key (`pnpm redeploy-after-reset`, [docs/testnet-reset.md](docs/testnet-reset.md)), so the addresses below stay; the pool gets new contract ids.'}`, '');
  if (manual.notes.blend) L.push(`**Blend.** ${manual.notes.blend}`, '');

  L.push('### Month-2 infrastructure, disclosed', '', '| Role | Address |', '|---|---|');
  TESTNET_CHANNELS.forEach((c, i) => L.push(`| Channel account ${i + 1} (source of sponsored setups only) | ${code(c)} |`));
  if (TESTNET_BLEND) {
    L.push(`| Pool admin and oracle admin (team script key) | ${code(TESTNET_BLEND.admin ?? 'Blend')} |`);
    L.push(`| Oracle (Blend's mock-sep-40, unmodified) | [${code(TESTNET_BLEND.oracle)}](${contractUrl(TESTNET_BLEND.oracle)}) |`);
    L.push(`| Pool (Corra TESTMXN, On-Ice) | [${code(TESTNET_BLEND.pool)}](${contractUrl(TESTNET_BLEND.pool)}) |`);
    L.push(`| Blend pool factory | [${code(TESTNET_BLEND.factory)}](${contractUrl(TESTNET_BLEND.factory)})${TESTNET_BLEND.factory === SOW_FACTORY ? '' : ` (Blend redeployed it; the SOW names ${code(SOW_FACTORY)})`} |`);
  } else {
    L.push('| Pool | not deployed (Blend has not redeployed its factory yet) |');
  }
  if ('demoRecipient' in TESTNET) L.push(`| Demo recipient (receives only; secret discarded) | ${code((TESTNET as { demoRecipient: string }).demoRecipient)} |`);
  L.push('');

  const titles = { 1: 'Deliverable 1: balance and send-from-balance', 2: 'Deliverable 2: Blend pool', 3: 'Deliverable 3: cash-out and channel accounts', 0: 'Walkthrough video' } as const;
  for (const d of [1, 2, 3, 0] as const) {
    L.push(`### ${titles[d]}`, '', '| SOW item | Evidence | Archive |', '|---|---|---|');
    for (const it of ITEMS.filter((i) => i.deliverable === d)) {
      const v = r.get(it.id);
      const p = v?.primary;
      const pending = BUILDER_ITEMS.includes(it.id) ? 'pending (builder)' : 'missing';
      let cell = p ? (it.id === 'video' ? `submitted privately (link not published)${p.note ? `; ${p.note.replace(/\|/g, '\\|')}` : ''}` : evidenceCell(p)) : pending;
      if (v?.warning) cell += ` (${v.warning})`;
      if (v?.archived) cell += `; before the reset: ${v.archived.hashes.map((h) => `[${short(h.hash)}](${EVIDENCE_ROOT}/${v.archived!.phase}/tx/${h.hash}.json)`).join(', ') || `[${v.archived.file}](${EVIDENCE_ROOT}/${v.archived.file})`}`;
      L.push(`| ${it.sow} | ${cell} | ${p ? archiveCell(p) : '-'} |`);
    }
    L.push('');
  }

  L.push('### Deviations and honesty notes', '');
  for (const dv of manual.deviations) L.push(`- ${dv}`);
  L.push("- Every payment and pool transaction has the sender's 0-XLM payment account as its transaction source; the sender is the operation source and the only signer, and Corra's sponsor pays the fee by fee-bump. Why: Freighter's fee check warns when the signer is also the fee source, and skips it when it is not (Varial, `docs/risks.md` R18).");
  L.push("- The pool admin and oracle admin is a team script key. The admin cannot move or lock anyone's deposit without a week of on-chain notice; withdrawals work in every pool state. Supply and withdraw never read the oracle price (`docs/risks.md` R22).");
  const anchorShot = (r.get('D3.anchorPage')?.primary?.files ?? []).some(isPng);
  L.push(`- The anchor's transaction page link carries a session token, so it is never published: the page is shown by ${anchorShot
    ? 'a screenshot and a saved copy of its HTML with the token removed' : 'a saved copy of its HTML with the token removed (screenshot pending)'}.`);
  const missing = ITEMS.filter((i) => !r.get(i.id)?.primary).map((i) => i.id);
  if (missing.length) L.push(`- Not done yet: ${missing.join(', ')}.`);
  L.push('', BLOCK_END);
  return L.join('\n');
}

/** The 64-hex strings of EVIDENCE.md outside the generated month-2 block (archive-tx --from-md: month 1 only). */
export function hashesOutsideBlock(md: string): string[] {
  const a = md.indexOf(BLOCK_START);
  const b = md.indexOf(BLOCK_END);
  const text = a >= 0 && b > a ? md.slice(0, a) + md.slice(b + BLOCK_END.length) : md;
  return text.match(/\b[0-9a-f]{64}\b/g) ?? [];
}

/** Replaces the block between the markers, or appends it under the month-2 heading. Throws on doubled markers. */
export function replaceBlock(md: string, block: string): string {
  const starts = md.split(BLOCK_START).length - 1;
  const ends = md.split(BLOCK_END).length - 1;
  if (starts > 1 || ends > 1 || starts !== ends) throw new Error('EVIDENCE.md: the evidence-index markers must appear exactly once each');
  if (starts === 1) {
    const a = md.indexOf(BLOCK_START);
    const b = md.indexOf(BLOCK_END) + BLOCK_END.length;
    if (b < a) throw new Error('EVIDENCE.md: the end marker comes before the start marker');
    return md.slice(0, a) + block + md.slice(b);
  }
  return `${md.replace(/\n*$/, '')}\n\n${MONTH2_HEADING}\n\n${block}\n`;
}

// ---------------------------------------------------------------------------------------------
// Checks

/** A pre-reset source written after the reset (a shell that wrote post-reset runs into pre-reset/, C6-1): one line each. */
export function lateSources(all: Source[]): string[] {
  return all.filter((s) => s.phase === 'pre-reset' && s.at !== '' && Date.parse(s.at) >= Date.parse(RESET_AT))
    .map((s) => `${s.item}: ${s.file} is pre-reset evidence written at ${s.at}, after the testnet reset (${RESET_AT}); move it to post-reset/`);
}

/** Problems with forbidden content under `paths` (files or directories): `token=`, a seed, a file over 2 MB. */
export function forbiddenIn(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    for (const f of existsSync(p) && statSync(p).isDirectory() ? listFiles(p) : existsSync(p) ? [p] : []) {
      if (statSync(f).size > MAX_FILE_BYTES) out.push(`${f}: larger than 2 MB`);
      if (/\.(png|jpe?g|webp|gif)$/i.test(f)) continue;
      const text = readFileSync(f, 'latin1');
      if (text.includes('token=')) out.push(`${f}: holds token=`);
      if (SEED.test(text)) out.push(`${f}: holds a seed-shaped string`);
    }
  }
  return out;
}

/** The contract an invoke_host_function operation calls: Horizon's first parameter (an Address ScVal). */
function invokedContract(op: any): string | undefined {
  const p = op?.parameters?.[0];
  if (op?.function !== 'HostFunctionTypeHostFunctionTypeInvokeContract' || p?.type !== 'Address') return undefined;
  try {
    return Address.fromScVal(xdr.ScVal.fromXDR(p.value, 'base64')).toString();
  } catch {
    return undefined;
  }
}

type Archived = { horizon: { transaction: any; operations: any[]; effects: any[] } };

function readArchive(root: string, phase: Phase, hash: string): Archived | null {
  const p = `${root}/${phase}/tx/${hash}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** [] = pass; otherwise one line per problem. */
export function checkItems(r: Resolved, root: string = EVIDENCE_ROOT, final = false): string[] {
  const out: string[] = [];
  // (1) a primary per item
  for (const it of ITEMS) {
    if (!r.get(it.id)?.primary && (final || !BUILDER_ITEMS.includes(it.id))) out.push(`${it.id}: no evidence`);
  }
  // (2) every cited hash archived in its phase
  for (const c of citedByPhase(r)) {
    if (!existsSync(`${root}/${c.phase}/tx/${c.hash}.json`)) out.push(`${c.item}: ${c.hash} not archived in ${c.phase}/tx (pnpm archive-tx --phase ${c.phase})`);
  }
  // (3) every referenced file exists
  for (const [id, v] of r) {
    for (const s of [v.primary, v.archived]) {
      if (!s) continue;
      if (s.file !== 'manual.json' && !existsSync(`${root}/${s.file}`)) out.push(`${id}: ${s.file} does not exist`);
      for (const f of s.files) if (!existsSync(`${root}/${f}`)) out.push(`${id}: ${f} does not exist`);
    }
  }
  // (4) the claims, offline against the archive: the primary and, after a reset, the pre-reset source
  // EVIDENCE.md still links (each read from its own phase's tx folder)
  const tx = (s: Source, i = 0) => (s.hashes[i] ? readArchive(root, s.phase, s.hashes[i].hash) : null);
  const claimed = (id: ItemId) => {
    const v = r.get(id);
    return [v?.primary, v?.archived].filter((s): s is Source => !!s);
  };
  const tag = (s: Source) => (s === r.get(s.item)?.archived ? ` (${s.phase})` : '');
  const d1 = D1_GROUP.map((id) => r.get(id)?.primary).filter((s): s is Source => !!s);
  if (d1.length === D1_GROUP.length && new Set(d1.map((s) => s.account)).size !== 1) out.push('D1: the deposit and the five sends are not one sender');
  for (const s of claimed('D1.deposit')) {
    if (!s.anchorRef) out.push(`D1.deposit${tag(s)}: ${s.hashes[0]?.hash ?? s.file} is not linked to an anchor transaction (no anchor ref)`);
    const a = tx(s);
    if (a && !(a.horizon.transaction.successful === true && a.horizon.operations.some((o: any) => o.type === 'payment' && o.from === TESTNET.anchorDistribution
      && o.to === s.account && o.asset_code === 'TESTMXN' && o.asset_issuer === TESTNET.corridorIssuer))) {
      out.push(`D1.deposit${tag(s)}: ${s.hashes[0].hash} has no successful TESTMXN payment from the anchor's distribution account to the sender`);
    }
  }
  const sendHashes = SENDS.map((f) => r.get(`D1.send.${f}` as ItemId)?.primary?.hashes[0]?.hash).filter(Boolean);
  if (sendHashes.length === SENDS.length && new Set(sendHashes).size !== SENDS.length) out.push('D1: the five sends are not five distinct transactions');
  for (const f of SENDS) {
    for (const s of claimed(`D1.send.${f}` as ItemId)) {
      const a = tx(s);
      if (!a) continue;
      const t = a.horizon.transaction;
      const problems: string[] = [];
      if (t.successful !== true) problems.push('not successful');
      if (t.fee_account !== TESTNET.feeSponsor) problems.push(`fee account ${t.fee_account}, not the sponsor`);
      const sends = a.horizon.operations.filter((o: any) => o.type === 'path_payment_strict_receive' && o.source_account === s.account);
      if (!sends.length) problems.push('no path_payment_strict_receive from the sender');
      else if (!sends.some((o: any) => o.asset_code === `TEST${f}` && o.asset_issuer === TESTNET.corridorIssuer)) problems.push(`the path payment does not deliver TEST${f} of the corridor issuer`);
      if (problems.length) out.push(`D1.send.${f}${tag(s)}: ${s.hashes[0].hash} ${problems.join(', ')}`);
    }
  }
  // The hosted flow is shown by the app itself: a manual entry cites its app.corra.money screenshot (S3-3).
  for (const s of claimed('D1.hosted')) {
    if (s.file === 'manual.json' && !s.files.some(isPng)) out.push(`D1.hosted${tag(s)}: no app.corra.money screenshot (a .png in its files)`);
  }
  // The anchor's page: the screenshot is required at --final (C3-2); until then the HTML alone is disclosed as such.
  if (final) {
    const p = r.get('D3.anchorPage')?.primary;
    if (p && !p.files.some(isPng)) out.push("D3.anchorPage: no screenshot of the anchor's page (a .png in its files)");
  }
  // The pool a D2 source must invoke: the one deployed now, or for an archived pre-reset source the
  // pool its own phase's D2.contract source names (the reset gives the pool a new id).
  const poolOf = (s: Source): string | undefined => {
    if (s !== r.get(s.item)?.archived) return TESTNET_BLEND?.pool;
    const c = claimed('D2.contract').find((x) => x.phase === s.phase);
    return c?.links.map((l) => /\/contract\/(C[A-Z2-7]{55})$/.exec(l.url)?.[1]).find(Boolean);
  };
  for (const id of ['D2.supply', 'D2.withdraw'] as const) {
    for (const s of claimed(id)) {
      const a = tx(s);
      if (!a) continue;
      const t = a.horizon.transaction;
      const problems: string[] = [];
      if (t.successful !== true) problems.push('not successful');
      if (t.fee_account !== TESTNET.feeSponsor) problems.push(`fee account ${t.fee_account}, not the sponsor`);
      const op = a.horizon.operations[0];
      if (op?.type !== 'invoke_host_function') problems.push('inner operation is not invoke_host_function');
      else {
        // S6-2: the supplier signs it (the operation's source, else the inner transaction's) and it invokes the pool.
        if ((op.source_account ?? t.source_account) !== s.account) problems.push(`source ${op.source_account ?? t.source_account}, not the supplier ${s.account ?? '(none recorded)'}`);
        const pool = poolOf(s);
        const invoked = invokedContract(op);
        if (!pool || invoked !== pool) problems.push(`invokes ${invoked ?? 'no contract'}, not the pool ${pool ?? '(none deployed)'}`);
      }
      if (problems.length) out.push(`${id}${tag(s)}: ${s.hashes[0].hash} ${problems.join(', ')}`);
    }
  }
  for (const s of claimed('D3.withdrawal')) {
    const a = tx(s);
    if (!a) continue;
    const t = a.horizon.transaction;
    const problems: string[] = [];
    // EVIDENCE.md presents the withdrawal as a fee-bump the sponsor paid.
    if (t.successful !== true) problems.push('not successful');
    if (t.fee_account !== TESTNET.feeSponsor) problems.push(`fee account ${t.fee_account}, not the sponsor`);
    // S6-2: from the recipient the cash-out source records (the operation source; its 0-XLM payment account is the transaction source).
    if (!a.horizon.operations.some((o: any) => o.type === 'payment' && o.from === s.account && o.to === TESTNET.anchorDistribution
      && o.asset_code === 'TESTPHP' && o.asset_issuer === TESTNET.corridorIssuer)) problems.push("has no TESTPHP payment from the recipient to the anchor's distribution account");
    if (problems.length) out.push(`D3.withdrawal${tag(s)}: ${s.hashes[0].hash} ${problems.join(', ')}`);
  }
  for (const s of claimed('D3.setups')) {
    const a = s.hashes.map((_h, i) => tx(s, i));
    if (a.length === 3 && a.every(Boolean)) {
      const sources = a.map((x) => x!.horizon.transaction.source_account);
      const ledgers = new Set(a.map((x) => x!.horizon.transaction.ledger));
      const problems: string[] = [];
      if (new Set(sources).size !== 3) problems.push('the three sources are not distinct');
      if (sources.some((x) => !TESTNET_CHANNELS.includes(x))) problems.push('a source is not a channel account');
      if (ledgers.size !== 1) problems.push(`ledgers ${[...ledgers].join(', ')}`);
      if (problems.length) out.push(`D3.setups${tag(s)}: ${problems.join(', ')}`);
    } else if (s.hashes.length !== 3) {
      out.push(`D3.setups${tag(s)}: ${s.hashes.length} transaction(s) cited, not three`);
    }
  }
  // (5) forbidden content
  out.push(...forbiddenIn([root]));
  return out;
}
