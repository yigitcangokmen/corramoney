export const CORR = [
  { iso:'PH', name:'Philippines', cur:'PHP', sym:'₱', rate:56.00 },
  { iso:'BR', name:'Brazil',      cur:'BRL', sym:'R$',     rate:5.40  },
  { iso:'AR', name:'Argentina',   cur:'ARS', sym:'AR$',    rate:1000  },
  { iso:'ID', name:'Indonesia',   cur:'IDR', sym:'Rp',     rate:15800 },
  { iso:'TH', name:'Thailand',    cur:'THB', sym:'฿', rate:33.00 }
];

export const TABS: [string, string][] = [
  ['send', 'Send'], ['balance', 'Balance'], ['cashout', 'Cash out'], ['history', 'History']
];

/** The saga's states as the sender sees them. */
export const SAGA_STEPS: [string, string, string][] = [
  ['SIGNED', 'Signed in your wallet', 'Held by Corra as a fully bound blob. No key ever left your device.'],
  ['CASH_IN', 'Cash-in confirmed', 'The anchor credited TESTMXN to your account, verified on chain.'],
  ['ONCHAIN', 'Submitted to Stellar', 'Your pre-signed path payment, fee paid by Corra.'],
  ['CREDITED', 'Recipient credited', 'Settled atomically through the USDC hub.']
];

/** A payment from the balance: no cash-in step, one signature submitted at once. */
export const BALANCE_STEPS: [string, string, string][] = [
  ['SIGNED', 'Signed in your wallet', 'One signature, valid for 5 minutes. No key ever left your device.'],
  ['CASH_IN', 'Paid from your balance', 'No anchor deposit needed: the TESTMXN was already in your account.'],
  ['ONCHAIN', 'Submitted to Stellar', 'Your signed path payment, fee paid by Corra.'],
  ['CREDITED', 'Recipient credited', 'Settled atomically through the USDC hub.']
];

/** The saga's states as anyone but the sender sees them (a received payment opens the same Track screen). */
export const RECEIVED_SAGA_STEPS: [string, string, string][] = [
  ['SIGNED', 'Signed by the sender', 'Held by Corra as a fully bound blob, signed in the sender\'s wallet.'],
  ['CASH_IN', 'Cash-in confirmed', 'The anchor credited the sender\'s cash-in, verified on chain.'],
  ['ONCHAIN', 'Submitted to Stellar', 'The sender\'s path payment, fee paid by Corra.'],
  ['CREDITED', 'Credited to your account', 'Settled atomically through the USDC hub.']
];

/** A payment from the sender's balance, as anyone but the sender sees it. */
export const RECEIVED_BALANCE_STEPS: [string, string, string][] = [
  ['SIGNED', 'Signed by the sender', 'One signature, valid for 5 minutes, signed in the sender\'s wallet.'],
  ['CASH_IN', 'Paid from the sender\'s balance', 'No anchor deposit needed: the TESTMXN was already in the sender\'s account.'],
  ['ONCHAIN', 'Submitted to Stellar', 'The sender\'s path payment, fee paid by Corra.'],
  ['CREDITED', 'Credited to your account', 'Settled atomically through the USDC hub.']
];
