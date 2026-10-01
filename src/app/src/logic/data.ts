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

export const TABS: [string, string][] = [
  ['deposit', 'Deposit'], ['send', 'Send'],
  ['yield', 'Earn'], ['history', 'History']
];

export const TRACK = [
  'Debiting your balance', 'Routing the payment', 'Submitting to Stellar', 'Completed'
];
