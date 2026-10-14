export const VAULTS = [
  { id:'blend',    name:'Blend',    apy:5.2, addr:'GAXGTNEY…W2WE',
    note:'USDC lending pool' },
  { id:'defindex', name:'DeFindex', apy:4.6, addr:'GBQK3RTX…P7LM',
    note:'Managed USDC strategy' }
];

export const CORR = [
  { iso:'PH', name:'Philippines', cur:'PHP', sym:'₱', rate:56.00 },
  { iso:'BR', name:'Brazil',      cur:'BRL', sym:'R$',     rate:5.40  },
  { iso:'AR', name:'Argentina',   cur:'ARS', sym:'AR$',    rate:1000  },
  { iso:'ID', name:'Indonesia',   cur:'IDR', sym:'Rp',     rate:15800 },
  { iso:'TH', name:'Thailand',    cur:'THB', sym:'฿', rate:33.00 }
];

// Earn is hidden until it routes deposits straight into Blend / DeFindex contracts.
export const TABS: [string, string][] = [
  ['send', 'Send'], ['history', 'History']
];

/** The saga's states as the sender sees them. */
export const SAGA_STEPS: [string, string, string][] = [
  ['SIGNED', 'Signed in your wallet', 'Held by Corra as a fully bound blob. No key ever left your device.'],
  ['CASH_IN', 'Cash-in confirmed', 'The anchor credited TESTMXN to your account, verified on chain.'],
  ['ONCHAIN', 'Submitted to Stellar', 'Your pre-signed path payment, fee paid by Corra.'],
  ['CREDITED', 'Recipient credited', 'Settled atomically through the USDC hub.']
];
