import { Decimal } from 'decimal.js';
import { sha256Hex } from './sha256.js';

/**
 * Configuração global determinística para cálculos financeiros e fiscais.
 * Escala padrão no banco: NUMERIC(18, 4).
 *
 * @spec SPEC-08
 * @spec SPEC-10
 * @spec SPEC-14
 * @spec SPEC-25
 * @rnf RNF-19
 * @rnf RNF-20
 */
export const MoneyDecimal = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Entrada monetária estritamente exata: proíbe `number` (float binário) em tempo de compilação.
 * Use sempre string decimal ("1500.50"), instância `Decimal` ou `bigint` (centavos/inteiro).
 */
export type MoneyInput = string | Decimal | bigint;

/**
 * Converte uma entrada monetária/preço para Decimal exato sem aritmética de float binário.
 *
 * @spec SPEC-10
 * @spec SPEC-14
 * @rnf RNF-19
 * @rnf RNF-20
 */
export function toDecimal(value: MoneyInput): Decimal {
  if (value instanceof Decimal) {
    return new MoneyDecimal(value.toString());
  }
  if (typeof value === 'bigint') {
    return new MoneyDecimal(value.toString());
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new RangeError('Valor monetário vazio não é permitido.');
  }
  return new MoneyDecimal(normalized);
}

/**
 * Formata um valor Decimal com exatamente 4 casas decimais para persistência em NUMERIC(18,4)
 * ou serialização exata em snapshots de auditoria.
 *
 * @spec SPEC-04
 * @spec SPEC-10
 * @rnf RNF-20
 */
export function toNumeric4String(value: MoneyInput): string {
  return toDecimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/**
 * Converte um valor monetário em BRL para inteiro exato em centavos (BigInt),
 * evitando qualquer imprecisão de ponto flutuante binário.
 *
 * @spec SPEC-08
 * @spec SPEC-25
 * @rnf RNF-20
 */
export function toCents(value: MoneyInput): bigint {
  const scaled = toDecimal(value).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return BigInt(scaled.toFixed(0));
}

/**
 * Converte um valor inteiro em centavos (BigInt) de volta para Decimal em BRL.
 *
 * @spec SPEC-08
 * @spec SPEC-25
 * @rnf RNF-20
 */
export function centsToDecimal(cents: bigint): Decimal {
  return new MoneyDecimal(cents.toString()).div(100);
}

/**
 * Calcula o hash SHA-256 determinístico para deduplicação idempotente de operações:
 * `hash(user_id, ticker, executed_at_minute, side, qty, price_cents)`.
 *
 * @spec SPEC-08
 * @rf RF-M1-7
 * @rnf RNF-9
 */
export function computeTradeDedupHash(params: {
  userId: string;
  ticker: string;
  executedAt: Date;
  side: string;
  qty: MoneyInput;
  price: MoneyInput;
}): string {
  const normalizedTicker = params.ticker.trim().toUpperCase();
  const normalizedSide = params.side.trim().toUpperCase();
  // Trunca para o minuto em UTC (YYYY-MM-DDTHH:mmZ)
  const executedAtMinute = params.executedAt.toISOString().slice(0, 16) + 'Z';
  const normalizedQty = toDecimal(params.qty).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
  const priceCents = toCents(params.price).toString();

  const payload = [
    params.userId.trim().toLowerCase(),
    normalizedTicker,
    executedAtMinute,
    normalizedSide,
    normalizedQty,
    priceCents,
  ].join('|');

  return sha256Hex(payload);
}

/**
 * Formata um valor Decimal em Real Brasileiro (PT-BR) sem perder precisão antes da formatação.
 *
 * @spec SPEC-18
 * @rnf RNF-23
 */
export function formatBrl(value: MoneyInput): string {
  const dec = toDecimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const negative = dec.isNegative();
  const absFixed = dec.abs().toFixed(2);
  const [integerPart = '0', decimalPart = '00'] = absFixed.split('.');
  const withThousands = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}R$ ${withThousands},${decimalPart}`;
}
