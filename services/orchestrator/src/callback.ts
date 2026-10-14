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

/** Maps the anchor's SEP-24 transaction body to the saga's callback shape. */
export function parseSep24Callback(body: any, nowMs: number): Sep24Callback | null {
  const tx = body?.transaction;
  if (!tx?.id || tx.kind !== 'deposit') return null;
  const status: LegStatus =
    tx.status === 'completed' ? 'CONFIRMED' : tx.status === 'error' || tx.status === 'expired' ? 'FAILED' : 'PENDING';
  return { ref: String(tx.id), kind: 'deposit', status, at: nowMs, raw: body };
}

/** Reads SIGNING_KEY from an anchor's stellar.toml. */
export async function fetchAnchorSigningKey(homeDomainUrl: string): Promise<string> {
  const r = await fetch(new URL('/.well-known/stellar.toml', homeDomainUrl));
  if (!r.ok) throw new Error(`stellar.toml ${r.status} from ${homeDomainUrl}`);
  const m = (await r.text()).match(/^\s*SIGNING_KEY\s*=\s*"(G[A-Z2-7]{55})"/m);
  if (!m) throw new Error(`no SIGNING_KEY in ${homeDomainUrl}/.well-known/stellar.toml`);
  return m[1];
}
