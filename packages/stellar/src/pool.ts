/**
 * The only Soroban shape the sponsor fee-bumps: one user-signed Blend `submit` on Corra's pool,
 * op source = from = spender = to = the signer, transaction source = the signer's payment account,
 * one supply or withdraw of the pool asset, authorized by the signer's own transaction signature
 * (source-account credentials, which authorize the operation source; no address-credential entry),
 * with a bounded resource fee and time window and no ledger key of the sponsor.
 * Pure: parses with stellar-sdk only, independent of the blend-sdk that built the transaction.
 */
import * as S from '@stellar/stellar-sdk';
import type { PoolOpKind } from '@corra/shared';

/** The most Corra pays in Soroban resource fees for one pool transaction: 0.5 XLM. */
export const MAX_SOROBAN_RESOURCE_FEE = 5_000_000n;
/** 1,000,000 units of a 7-decimal asset. */
export const MAX_POOL_AMOUNT_RAW = 10_000_000_000_000n;
export const POOL_MAX_TTL_SEC = 360;
/** Inclusion fee the inner transaction may bid above its resource fee, in stroops. */
export const MAX_INNER_INCLUSION = 100n;

export type PoolScope = { poolId: string; asset: string; maxAmountRaw: bigint; maxResourceFee: bigint };
/** `account` is the signer (the operation source); `paymentAccount` the transaction source. */
export type PoolSubmitFacts = {
  hash: string; account: string; paymentAccount: string; kind: PoolOpKind; amountRaw: bigint; resourceFee: bigint; maxTime: number;
};

export class PoolRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PoolRefusal';
  }
}

const refuse = (reason: string): never => {
  throw new PoolRefusal(reason);
};

const KINDS: Record<number, PoolOpKind> = { 0: 'supply', 1: 'withdraw' };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** stellar-sdk 17.4 XDR object model: unions carry `.type` and the arm in `.value`, structs camelCase fields. */
type X = any;

/** True when `v` (recursively through vectors and maps) holds an address equal to `who`. */
function namesAddress(v: X, who: string): boolean {
  if (!v) return false;
  if (v.type === 'scvAddress') return S.Address.fromScAddress(v.value).toString() === who;
  if (v.type === 'scvVec') return (v.value ?? []).some((x: X) => namesAddress(x, who));
  if (v.type === 'scvMap') return (v.value ?? []).some((e: X) => namesAddress(e.key, who) || namesAddress(e.val, who));
  return false;
}

/** A footprint key that belongs to the sponsor: its account, one of its trustlines, or contract data keyed by its address. */
function touches(k: X, sponsor: string): boolean {
  if (k.type === 'account' || k.type === 'trustline') {
    return S.StrKey.encodeEd25519PublicKey(Buffer.from(k.value.accountId.value.value)) === sponsor;
  }
  if (k.type === 'contractData') return namesAddress(k.value.key, sponsor);
  return false;
}

/** The account a `scvAddress` argument names, or null for a contract or anything else. */
function accountOf(v: X): string | null {
  if (v?.type !== 'scvAddress' || v.value?.type !== 'scAddressTypeAccount') return null;
  return S.Address.fromScAddress(v.value).toString();
}

/** True for a `scvAddress` that names a contract. */
const isContract = (v: X) => v?.type === 'scvAddress' && v.value?.type === 'scAddressTypeContract';

/**
 * Proves `innerXdr` is a pool `submit` Corra may fee-bump. Rules in a fixed order, each with its
 * own message. Not checked on purpose: the sequence (the chain refuses it) and the balance (Blend
 * fails the transaction; the browser simulated it first).
 */
export function assertPoolSubmit(innerXdr: string, scope: PoolScope, networkPassphrase: string, nowSec: number, sponsor: string): PoolSubmitFacts {
  // R1, R2
  let parsed: S.Transaction | S.FeeBumpTransaction;
  try {
    parsed = S.TransactionBuilder.fromXDR(innerXdr, networkPassphrase);
  } catch {
    return refuse('not a transaction envelope');
  }
  if (parsed instanceof S.FeeBumpTransaction) refuse('already fee-bumped');
  const tx = parsed as S.Transaction;
  // R3, R3b
  if (!S.StrKey.isValidEd25519PublicKey(tx.source)) refuse('source must be a plain G account');
  if (tx.source === sponsor) refuse('sponsor cannot be the inner source');
  // R4-R6
  if (tx.operations.length !== 1) refuse('exactly one operation');
  const op = tx.operations[0] as X;
  if (op.type !== 'invokeHostFunction' || op.func?.type !== 'hostFunctionTypeInvokeContract') refuse('only a contract call');
  const signer: string = op.source;
  if (!S.StrKey.isValidEd25519PublicKey(signer ?? '') || signer === tx.source || signer === sponsor) {
    refuse('operation source must be the signer, apart from the transaction source and the sponsor');
  }
  // R7, R8
  const ic = op.func.value;
  if (S.Address.fromScAddress(ic.contractAddress).toString() !== scope.poolId) refuse('only the Corra pool');
  if (String(ic.functionName) !== 'submit') refuse('only submit');
  // R9
  const args: X[] = ic.args ?? [];
  if (args.length !== 4 || args.slice(0, 3).some((a) => accountOf(a) !== signer)) refuse('from, spender and to must be the signer');
  // R10, R11
  if (args[3].type !== 'scvVec' || (args[3].value ?? []).length !== 1) refuse('exactly one request');
  // Raw arms first: scValToNative would turn a u64 amount into a bigint, an i32 type into a number,
  // and throw on a map with a repeated key. Three entries holding all three names means no repeat.
  const m: X = args[3].value[0];
  const arm = (k: string) => (m.value as X[]).find((e) => e.key.type === 'scvSymbol' && String(e.key.value) === k)?.val;
  if (m?.type !== 'scvMap' || (m.value ?? []).length !== 3 ||
      !isContract(arm('address')) || arm('amount')?.type !== 'scvI128' || arm('request_type')?.type !== 'scvU32') {
    refuse('malformed request');
  }
  const req = {
    address: S.Address.fromScAddress(arm('address').value).toString(), amount: S.scValToBigInt(arm('amount')), request_type: Number(arm('request_type').value),
  };
  // R12-R14
  const kind = KINDS[req.request_type];
  if (!kind) refuse('only supply or withdraw');
  if (req.address !== scope.asset) refuse('only the pool asset');
  const amount: bigint = req.amount;
  if (amount <= 0n || amount > scope.maxAmountRaw) refuse('amount out of range');
  // R15: one entry, authorized by the transaction signature, rooted at this very call
  const auth: X[] = op.auth ?? [];
  if (auth.some((a) => a.credentials.type !== 'sorobanCredentialsSourceAccount')) refuse('address-credential auth entries are not allowed');
  if (auth.length !== 1) refuse('exactly one auth entry');
  const root = auth[0].rootInvocation;
  if (root.function.type !== 'sorobanAuthorizedFunctionTypeContractFn' ||
      !sameBytes(root.function.value.toXdr(), ic.toXdr())) {
    refuse('auth must be the signer\'s own submit');
  }
  // R16: supply moves exactly the request from the signer to the pool; withdraw moves nothing on the signer's authority
  const subs: X[] = root.subInvocations ?? [];
  if (kind === 'withdraw' && subs.length) refuse('unexpected sub-invocation');
  if (kind === 'supply') {
    const sub = subs[0];
    const ok = subs.length === 1 && sub.function.type === 'sorobanAuthorizedFunctionTypeContractFn' && !(sub.subInvocations ?? []).length &&
      S.Address.fromScAddress(sub.function.value.contractAddress).toString() === scope.asset &&
      String(sub.function.value.functionName) === 'transfer' && sub.function.value.args.length === 3 && (() => {
        const [from, to, amt]: X[] = sub.function.value.args;
        return accountOf(from) === signer && isContract(to) && S.Address.fromScAddress(to.value).toString() === scope.poolId &&
          amt.type === 'scvI128' && S.scValToBigInt(amt) === amount;
      })();
    if (!ok) refuse('unexpected sub-invocation');
  }
  // R17, R18
  const env = tx.toEnvelope() as X;
  const ext = env.value.tx.ext;
  if (env.type !== 'envelopeTypeTx' || ext.type !== 'sorobanData') refuse('not a Soroban transaction');
  const resourceFee: bigint = BigInt(ext.value.resourceFee);
  if (resourceFee < 0n || resourceFee > scope.maxResourceFee) refuse('resource fee out of range');
  const fee = BigInt(tx.fee);
  if (fee < resourceFee || fee > resourceFee + MAX_INNER_INCLUSION) refuse('inner fee must be the resource fee (plus at most 100 stroops)');
  // R19
  const fp = ext.value.resources.footprint;
  if ([...fp.readOnly, ...fp.readWrite].some((k: X) => touches(k, sponsor))) refuse('footprint touches the sponsor');
  // R20, R21
  if (tx.memo.type !== 'none') refuse('no memo');
  const tb = tx.timeBounds;
  const maxTime = Number(tb?.maxTime ?? 0);
  if (!tb || Number(tb.minTime) !== 0 || maxTime <= nowSec || maxTime > nowSec + POOL_MAX_TTL_SEC) {
    refuse('needs a time bound within the next 6 minutes');
  }
  if (tx.ledgerBounds || tx.minAccountSequence !== undefined || Number(tx.minAccountSequenceAge ?? 0) !== 0 ||
      Number(tx.minAccountSequenceLedgerGap ?? 0) !== 0 || (tx.extraSigners ?? []).length) {
    refuse('no other preconditions');
  }
  // R22
  const hash = tx.hash();
  const signerKey = S.Keypair.fromPublicKey(signer);
  const sig: X = (tx.signatures[0] as X)?.signature;
  const sigBytes: Uint8Array | undefined = sig instanceof Uint8Array ? sig : sig?.value;
  if (tx.signatures.length !== 1 || !sigBytes || !signerKey.verify(Buffer.from(hash), Buffer.from(sigBytes))) {
    refuse('must be signed once by its operation source');
  }
  return { hash: toHex(hash), account: signer, paymentAccount: tx.source, kind: kind!, amountRaw: amount, resourceFee, maxTime };
}
