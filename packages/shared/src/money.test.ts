import { describe, expect, it } from 'vitest';
import { add, compare, formatUnits, fromDecimal, parseUnits, roundUp, toDecimal, withSlippage } from './money';

const MXN = { code: 'TESTMXN', issuer: 'GISSUER' };
const PHP = { code: 'TESTPHP', issuer: 'GISSUER' };

describe('parseUnits / formatUnits', () => {
  it('round-trips 7-decimal amounts without float drift', () => {
    expect(parseUnits('0.1')).toBe(1_000_000n);
    expect(parseUnits('3500.00')).toBe(35_000_000_000n);
    expect(formatUnits(parseUnits('329.3190139'))).toBe('329.3190139');
    expect(formatUnits(parseUnits('0.1') + parseUnits('0.2'))).toBe('0.3000000');
  });

  it('rejects anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', '-1', '1e5', '1.', '.5', 'abc', '1,000']) {
      expect(() => parseUnits(bad)).toThrow();
    }
  });

  it('rejects more than 7 decimals instead of silently rounding', () => {
    expect(() => parseUnits('1.00000001')).toThrow(/7 decimals/);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER', () => {
    expect(toDecimal(fromDecimal(MXN, '158000000000.0000001'))).toBe('158000000000.0000001');
  });
});

describe('arithmetic', () => {
  it('refuses to mix assets', () => {
    expect(() => add(fromDecimal(MXN, '1'), fromDecimal(PHP, '1'))).toThrow(/asset mismatch/);
    expect(() => compare(fromDecimal(MXN, '1'), fromDecimal(PHP, '1'))).toThrow(/asset mismatch/);
  });

  it('compares same-asset amounts', () => {
    expect(compare(fromDecimal(MXN, '2'), fromDecimal(MXN, '1'))).toBe(1);
    expect(compare(fromDecimal(MXN, '1'), fromDecimal(MXN, '1.0000000'))).toBe(0);
  });
});

describe('roundUp', () => {
  it('rounds a 7-decimal cap up to whole centavos so the deposit still covers it', () => {
    expect(toDecimal(roundUp(fromDecimal(MXN, '334.2587992'), 2))).toBe('334.2600000');
    expect(toDecimal(roundUp(fromDecimal(MXN, '334.26'), 2))).toBe('334.2600000');
    expect(toDecimal(roundUp(fromDecimal(MXN, '0.0000001'), 2))).toBe('0.0100000');
  });
});

describe('withSlippage', () => {
  it('rounds up so the sendMax cap is never below the quoted cost', () => {
    // 150 bps on 1 stroop: 1.015 stroops must become 2, not 1.
    expect(withSlippage({ asset: MXN, raw: 1n }, 150).raw).toBe(2n);
    expect(toDecimal(withSlippage(fromDecimal(MXN, '3500'), 150))).toBe('3552.5000000');
  });

  it('rejects negative or fractional bps', () => {
    expect(() => withSlippage(fromDecimal(MXN, '1'), -1)).toThrow();
    expect(() => withSlippage(fromDecimal(MXN, '1'), 1.5)).toThrow();
  });
});

describe('Stellar amount bounds', () => {
  it('rejects amounts above int64 stroops, including after slippage', () => {
    expect(() => parseUnits('922337203685.4775808')).toThrow(/maximum/);
    expect(parseUnits('922337203685.4775807')).toBe(2n ** 63n - 1n);
    expect(() => withSlippage(fromDecimal(MXN, '922337203685'), 150)).toThrow(/maximum/);
  });
});
