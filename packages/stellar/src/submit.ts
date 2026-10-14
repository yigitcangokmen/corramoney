export type SubmitOutcome =
  | { kind: 'success'; hash: string; ledger: number }
  /** strict-receive cost exceeded sendMax: the tx landed as failed, nothing moved, the blob is spent. */
  | { kind: 'cap_exceeded'; hash?: string; codes: unknown }
  /** maxTime passed: never entered a ledger. */
  | { kind: 'expired'; codes: unknown }
  /** the sender's sequence moved outside the minSeqNum window: permanently dead. */
  | { kind: 'bad_seq'; codes: unknown }
  | { kind: 'failed'; hash?: string; codes: unknown };

type HorizonErrorData = {
  extras?: {
    hash?: string;
    result_codes?: { transaction?: string; inner_transaction?: string; operations?: string[] };
  };
};

/** Maps Horizon's submission error body to an outcome the saga can act on. */
export function classifySubmitError(data: HorizonErrorData | undefined): SubmitOutcome {
  const codes = data?.extras?.result_codes;
  const hash = data?.extras?.hash;
  const txCode = codes?.inner_transaction ?? codes?.transaction;
  const ops = codes?.operations ?? [];

  if (ops.includes('op_over_source_max') || ops.includes('op_over_sendmax')) {
    return { kind: 'cap_exceeded', hash, codes };
  }
  if (txCode === 'tx_too_late') return { kind: 'expired', codes };
  if (txCode === 'tx_bad_seq' || txCode === 'tx_bad_minseq_age_or_gap') return { kind: 'bad_seq', codes };
  return { kind: 'failed', hash, codes };
}
