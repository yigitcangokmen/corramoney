/**
 * Canonical user-signed Blend pool `submit` blobs for tests, built offline: the operation from
 * blend-sdk's PoolContractV2.submit, a hand-built source-account auth entry and Soroban data shaped
 * like a landed testnet supply. `mutate` changes one thing before signing.
 * Lives outside src: not scanned by no-server-side-signing, not a test file itself.
 */
import * as S from '@stellar/stellar-sdk';
import { PoolContractV2 } from '@blend-capital/blend-sdk';
import { randomBytes } from 'node:crypto';

export const NP = S.Networks.TESTNET;
export const NOW = 1_800_000_000;
export const RESOURCE_FEE = 688_005n;
export const AMOUNT = 200_000_000n;
export const FAKE_POOL = S.StrKey.encodeContract(randomBytes(32));
export const FAKE_SAC = S.StrKey.encodeContract(randomBytes(32));
export const ISSUER = S.Keypair.random().publicKey();
export const user = S.Keypair.random();
/** The user's payment account: the transaction source; the user is the operation source and signer. */
export const PAYMENT_ACCOUNT = S.Keypair.random().publicKey();
export const SCOPE = { poolId: FAKE_POOL, asset: FAKE_SAC, maxAmountRaw: 10_000_000_000_000n, maxResourceFee: 5_000_000n };

export type Kind = 'supply' | 'withdraw';

export type Draft = {
  kind: Kind;
  /** The signer: operation source and from = spender = to. */
  source: string;
  /** The transaction source (the signer's payment account). */
  txSource: string;
  contract: string;
  fn: string;
  from: string;
  spender: string;
  to: string;
  requests: { request_type: number; address: string; amount: bigint }[];
  /** Replaces the four submit arguments when set. */
  args?: S.xdr.ScVal[];
  /** Replaces the canonical auth entries (built from the final call). */
  auth?: (canonical: S.xdr.SorobanAuthorizationEntry[], ic: S.xdr.InvokeContractArgs) => S.xdr.SorobanAuthorizationEntry[];
  /** Replaces the canonical supply transfer sub-invocation list. */
  subs?: (canonical: S.xdr.SorobanAuthorizedInvocation[]) => S.xdr.SorobanAuthorizedInvocation[];
  opSource?: string;
  /** Builds the transaction around this operation instead of the submit call. */
  replaceOp?: S.xdr.Operation;
  extraOps: S.xdr.Operation[];
  /** A muxed (M...) source with this id. */
  muxedId?: string;
  resourceFee: bigint;
  fee: bigint;
  sorobanData: boolean;
  readOnly: S.xdr.LedgerKey[];
  readWrite: S.xdr.LedgerKey[];
  memo?: S.Memo;
  minTime: number;
  maxTime: number;
  ledgerbounds?: { minLedger: number; maxLedger: number };
  minAccountSequence?: string;
  minAccountSequenceAge?: bigint;
  minAccountSequenceLedgerGap?: number;
  extraSigners?: string[];
  signers: S.Keypair[];
};

export const accountKey = (g: string) =>
  S.xdr.LedgerKey.account(new S.xdr.LedgerKeyAccount({ accountId: S.Keypair.fromPublicKey(g).xdrAccountId() }));
export const trustlineKey = (g: string, code = 'TESTMXN', issuer = ISSUER) =>
  S.xdr.LedgerKey.trustline(new S.xdr.LedgerKeyTrustLine({
    accountId: S.Keypair.fromPublicKey(g).xdrAccountId(), asset: new S.Asset(code, issuer).toTrustLineXDRObject(),
  }));
export const dataKey = (contract: string, key: S.xdr.ScVal) =>
  S.xdr.LedgerKey.contractData(new S.xdr.LedgerKeyContractData({
    contract: new S.Address(contract).toScAddress(), key, durability: S.xdr.ContractDataDurability.persistent,
  }));
const codeKey = () => S.xdr.LedgerKey.contractCode(new S.xdr.LedgerKeyContractCode({ hash: randomBytes(32) }));
const POOL_WASM = codeKey();

export const contractFn = (contract: string, fn: string, args: S.xdr.ScVal[]) =>
  S.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new S.xdr.InvokeContractArgs({
    contractAddress: new S.Address(contract).toScAddress(), functionName: fn, args,
  }));
export const invocation = (fn: S.xdr.SorobanAuthorizedFunction, subInvocations: S.xdr.SorobanAuthorizedInvocation[] = []) =>
  new S.xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations });
export const transfer = (from: string, to: string, amount: bigint, sac = FAKE_SAC) =>
  invocation(contractFn(sac, 'transfer', [new S.Address(from).toScVal(), new S.Address(to).toScVal(), S.nativeToScVal(amount, { type: 'i128' })]));
export const sourceEntry = (root: S.xdr.SorobanAuthorizedInvocation) => new S.xdr.SorobanAuthorizationEntry({
  credentials: S.xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root,
});
export const addressEntry = (who: string, root: S.xdr.SorobanAuthorizedInvocation) => new S.xdr.SorobanAuthorizationEntry({
  credentials: S.xdr.SorobanCredentials.sorobanCredentialsAddress(new S.xdr.SorobanAddressCredentials({
    address: new S.Address(who).toScAddress(), nonce: 1n, signatureExpirationLedger: 100, signature: S.xdr.ScVal.scvVoid(),
  })),
  rootInvocation: root,
});

export function draftOf(kind: Kind, source = user): Draft {
  const pk = source.publicKey();
  return {
    kind, source: pk, txSource: PAYMENT_ACCOUNT, opSource: pk, contract: FAKE_POOL, fn: 'submit', from: pk, spender: pk, to: pk,
    requests: [{ request_type: kind === 'supply' ? 0 : 1, address: FAKE_SAC, amount: AMOUNT }],
    extraOps: [], resourceFee: RESOURCE_FEE, fee: RESOURCE_FEE, sorobanData: true,
    // As a landed testnet supply: SAC and pool instances, the pool WASM and the issuer read; the user's trustline and pool data written.
    readOnly: [new S.Contract(FAKE_SAC).getFootprint(), new S.Contract(FAKE_POOL).getFootprint(), POOL_WASM, accountKey(ISSUER)],
    readWrite: [trustlineKey(pk), dataKey(FAKE_POOL, S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol('Positions'), new S.Address(pk).toScVal()])),
      dataKey(FAKE_POOL, S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol('ResData'), new S.Address(FAKE_SAC).toScVal()]))],
    minTime: 0, maxTime: NOW + 300, signers: [source],
  };
}

/** The canonical signed blob of `kind`, after `mutate`. */
export function canonical(kind: Kind, mutate?: (d: Draft) => void, source = user): string {
  return build(draftOf(kind, source), mutate).toXDR();
}

export function build(d: Draft, mutate?: (d: Draft) => void): S.Transaction {
  mutate?.(d);
  const built = S.Operation.fromXDRObject(S.xdr.Operation.fromXDR(new PoolContractV2(d.contract).submit({
    from: d.from, spender: d.spender, to: d.to, requests: d.requests,
  }), 'base64')) as S.Operation.InvokeHostFunction;
  // stellar-sdk 17.4 XDR object model: the union arm is `.value`, struct fields are properties.
  const call = (built.func as any).value;
  const ic = new S.xdr.InvokeContractArgs({ contractAddress: call.contractAddress, functionName: d.fn, args: d.args ?? call.args });
  const func = S.xdr.HostFunction.hostFunctionTypeInvokeContract(ic);
  const supply = d.requests[0];
  const canonicalSubs = d.kind === 'supply' && supply ? [transfer(d.source, d.contract, supply.amount)] : [];
  const subs = d.subs ? d.subs(canonicalSubs) : canonicalSubs;
  const entries = [sourceEntry(invocation(S.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(ic), subs))];
  const auth = d.auth ? d.auth(entries, ic) : entries;
  // With Soroban data the builder adds the resource fee to the bid (fee '0' -> fee = resourceFee).
  const bid = d.sorobanData ? d.fee - d.resourceFee : d.fee;
  const account = new S.Account(d.txSource, '41');
  const b = new S.TransactionBuilder(account, {
    fee: (bid < 0n ? 0n : bid).toString(), networkPassphrase: NP,
    timebounds: { minTime: d.minTime, maxTime: d.maxTime },
    ...(d.ledgerbounds ? { ledgerbounds: d.ledgerbounds } : {}),
    ...(d.minAccountSequence ? { minAccountSequence: d.minAccountSequence } : {}),
    ...(d.minAccountSequenceAge ? { minAccountSequenceAge: d.minAccountSequenceAge } : {}),
    ...(d.minAccountSequenceLedgerGap ? { minAccountSequenceLedgerGap: d.minAccountSequenceLedgerGap } : {}),
    ...(d.extraSigners ? { extraSigners: d.extraSigners } : {}),
  }).addOperation(d.replaceOp ?? S.Operation.invokeHostFunction({ func, auth, ...(d.opSource ? { source: d.opSource } : {}) }));
  for (const op of d.extraOps) b.addOperation(op);
  if (d.sorobanData) {
    b.setSorobanData(new S.SorobanDataBuilder().setResourceFee(d.resourceFee.toString()).setReadOnly(d.readOnly).setReadWrite(d.readWrite).build());
  }
  let out = b.build();
  // The 17.4 builder refuses a memo or a muxed source on a Soroban transaction, and adds the
  // resource fee to the bid: write what the draft says straight into the envelope.
  if (BigInt(out.fee) !== d.fee || d.memo || d.muxedId) {
    const env = out.toEnvelope() as any;
    env.value.tx.fee = Number(d.fee);
    if (d.memo) env.value.tx.memo = d.memo.toXDRObject();
    if (d.muxedId) env.value.tx.sourceAccount = new S.MuxedAccount(account, d.muxedId).toXDRObject();
    out = new S.Transaction(env, NP);
  }
  for (const k of d.signers) out.sign(k);
  return out;
}
