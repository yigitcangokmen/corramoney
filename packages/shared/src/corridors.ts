export type CountryFiat = { country: string; currency: string };
export type Corridor = { from: CountryFiat; to: CountryFiat };

/** Test asset code per fiat. Stellar asset codes are alphanumeric only, hence no underscore. */
export const FIAT = {
  MXN: { country: 'MX', currency: 'MXN', code: 'TESTMXN', perUsd: 18.35 },
  PHP: { country: 'PH', currency: 'PHP', code: 'TESTPHP', perUsd: 56 },
  BRL: { country: 'BR', currency: 'BRL', code: 'TESTBRL', perUsd: 5.4 },
  ARS: { country: 'AR', currency: 'ARS', code: 'TESTARS', perUsd: 1000 },
  IDR: { country: 'ID', currency: 'IDR', code: 'TESTIDR', perUsd: 15800 },
  THB: { country: 'TH', currency: 'THB', code: 'TESTTHB', perUsd: 33 },
} as const;

export type FiatCode = keyof typeof FIAT;

export const SOURCE_FIAT: FiatCode = 'MXN';
export const DEST_FIATS: FiatCode[] = ['PHP', 'BRL', 'ARS', 'IDR', 'THB'];

export const corridorKey = (c: Corridor) =>
  `${c.from.country}/${c.from.currency}->${c.to.country}/${c.to.currency}`;
