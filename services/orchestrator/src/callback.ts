import * as S from '@stellar/stellar-sdk';
import type { LegStatus, Sep24Callback } from '@corra/shared';

const MAX_SKEW_SEC = 300;

/**
 * SEP-24 callback signature: header `Signature: t=<unix>, s=<base64>` over `<t>.<host>.<body>`,
 * signed with the SIGNING_KEY the anchor publishes in its stellar.toml.
 */
export function verifyCallbackSignature(opts: {
  header: string | undefined;
  host: string;
  body: string;
  anchorSigningKey: string;
  nowSec: number;
}): { ok: true } | { ok: false; reason: string } {
  if (!opts.header) return { ok: false, reason: 'missing Signature header' };
  const parts = Object.fromEntries(
    opts.header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.s) return { ok: false, reason: 'malformed Signature header' };
  if (Math.abs(opts.nowSec - t) > MAX_SKEW_SEC) return { ok: false, reason: 'stale or future timestamp' };
  const payload = new TextEncoder().encode(`${parts.t}.${opts.host}.${opts.body}`);
  const sig = Uint8Array.from(atob(parts.s), (c) => c.charCodeAt(0));
  try {
    if (!S.Keypair.fromPublicKey(opts.anchorSigningKey).verify(Buffer.from(payload), Buffer.from(sig))) {
      return { ok: false, reason: 'bad signature' };
    }
  } catch {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true };
}

/** An anchor's payout reference: the same charset and length as a transaction ref. */
const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** The memo a withdrawal asks for, as Corra compares it (hash memos base64); undefined when absent or malformed. */
function withdrawMemoOf(tx: any): Sep24Callback['withdrawMemo'] {
  const v = tx.withdraw_memo;
  if (typeof v !== 'string') return undefined;
  if (tx.withdraw_memo_type === 'id') return /^\d{1,20}$/.test(v) ? { type: 'id', value: v } : undefined;
  if (tx.withdraw_memo_type === 'text') return Buffer.byteLength(v, 'utf8') <= 28 ? { type: 'text', value: v } : undefined;
  if (tx.withdraw_memo_type === 'hash') {
    // Anchor Platform reports hash memos in hex; Horizon and Corra use base64.
    if (/^[0-9a-f]{64}$/i.test(v)) return { type: 'hash', value: Buffer.from(v, 'hex').toString('base64') };
    if (/^[A-Za-z0-9+/]{43}=$/.test(v)) return { type: 'hash', value: v };
  }
  return undefined;
}

/** Maps the anchor's SEP-24 transaction body to the saga's callback shape: deposits and withdrawals, nothing else. */
export function parseSep24Callback(body: any, nowMs: number): Sep24Callback | null {
  const tx = body?.transaction;
  if (!tx?.id || (tx.kind !== 'deposit' && tx.kind !== 'withdrawal')) return null;
  const withdrawal = tx.kind === 'withdrawal';
  const failed = tx.status === 'error' || tx.status === 'expired' || (withdrawal && tx.status === 'refunded');
  const status: LegStatus = tx.status === 'completed' ? 'CONFIRMED' : failed ? 'FAILED' : 'PENDING';
  const withdrawMemo = withdrawal ? withdrawMemoOf(tx) : undefined;
  return {
    ref: String(tx.id),
    kind: tx.kind,
    status,
    anchorStatus: String(tx.status),
    ...(typeof tx.stellar_transaction_id === 'string' && tx.stellar_transaction_id ? { stellarTxId: tx.stellar_transaction_id } : {}),
    // Stored and shown as a link, so only an http(s) URL of sane length.
    // Anchor Platform reports hash memos in hex; Horizon and cashInMemo use base64.
    ...(!withdrawal && tx.deposit_memo_type === 'hash' && typeof tx.deposit_memo === 'string' && /^[0-9a-f]{64}$/i.test(tx.deposit_memo)
      ? { depositMemo: Buffer.from(tx.deposit_memo, 'hex').toString('base64') } : {}),
    // The account the anchor pays; a withdrawal's `to` is the anchor's own account, so it is not read (J109).
    ...(!withdrawal && typeof tx.to === 'string' && /^G[A-Z2-7]{55}$/.test(tx.to) ? { account: tx.to } : {}),
    ...(typeof tx.more_info_url === 'string' && /^https?:\/\//.test(tx.more_info_url) && tx.more_info_url.length <= 512
      ? { moreInfoUrl: tx.more_info_url } : {}),
    ...(withdrawMemo ? { withdrawMemo } : {}),
    ...(withdrawal && typeof tx.external_transaction_id === 'string' && EXTERNAL_ID.test(tx.external_transaction_id)
      ? { externalId: tx.external_transaction_id } : {}),
    at: nowMs,
    raw: body,
  };
}

/** Reads SIGNING_KEY from an anchor's stellar.toml. */
export async function fetchAnchorSigningKey(homeDomainUrl: string): Promise<string> {
  const r = await fetch(new URL('/.well-known/stellar.toml', homeDomainUrl));
  if (!r.ok) throw new Error(`stellar.toml ${r.status} from ${homeDomainUrl}`);
  const m = (await r.text()).match(/^\s*SIGNING_KEY\s*=\s*"(G[A-Z2-7]{55})"/m);
  if (!m) throw new Error(`no SIGNING_KEY in ${homeDomainUrl}/.well-known/stellar.toml`);
  return m[1];
}
