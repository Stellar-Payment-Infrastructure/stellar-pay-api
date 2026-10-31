/**
 * Integer-only amount helpers. Amounts are token base units (`bigint`); the
 * API carries them as decimal strings. No floating point anywhere.
 */

const BASE_UNITS_RE = /^-?\d+$/;

/** Parses an API amount string (base units) into a bigint. */
export function toBigInt(amount: string | bigint): bigint {
  if (typeof amount === 'bigint') return amount;
  if (!BASE_UNITS_RE.test(amount)) throw new TypeError(`invalid base-unit amount: ${JSON.stringify(amount)}`);
  return BigInt(amount);
}

/**
 * Formats base units for display, e.g. `formatAmount(12345678n, 7)` -> `"1.2345678"`.
 * `minFractionDigits` pads (e.g. 2 -> "5.00"); trailing zeros beyond it are trimmed.
 */
export function formatAmount(amount: string | bigint, decimals: number, opts: { minFractionDigits?: number } = {}): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new RangeError('decimals must be 0..38');
  const v = toBigInt(amount);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = decimals > 0 ? (abs % scale).toString().padStart(decimals, '0') : '';
  const min = Math.min(opts.minFractionDigits ?? 0, decimals);
  frac = frac.replace(/0+$/, '');
  if (frac.length < min) frac = frac.padEnd(min, '0');
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/**
 * Parses a human decimal ("1.5") into base units. Rejects more fractional
 * digits than the token supports instead of rounding.
 */
export function parseAmount(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new RangeError('decimals must be 0..38');
  const s = input.trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new TypeError(`invalid amount: ${JSON.stringify(input)}`);
  const [, sign, whole = '', frac = ''] = m;
  if (frac.length > decimals) throw new RangeError(`amount has more than ${decimals} decimal places`);
  const units = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac || '').padEnd(decimals, '0') || '0');
  return sign === '-' ? -units : units;
}
