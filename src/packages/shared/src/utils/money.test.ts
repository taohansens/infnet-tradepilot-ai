import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  centsToDecimal,
  computeTradeDedupHash,
  formatBrl,
  toCents,
  toDecimal,
  toNumeric4String,
} from './money.js';
import { sha256Hex } from './sha256.js';

/**
 * Testes unitários de precisão monetária determinística (sem ponto flutuante binário)
 * e hash de deduplicação idempotente.
 *
 * @spec SPEC-08
 * @spec SPEC-14
 * @spec SPEC-25
 * @rnf RNF-9
 * @rnf RNF-19
 * @rnf RNF-20
 */
describe('Utilitários monetários determinísticos (Decimal / Centavos)', () => {
  it('evita erro clássico de float binário (0.1 + 0.2 === 0.3)', () => {
    const sum = toDecimal('0.10').plus(toDecimal('0.20'));
    expect(toNumeric4String(sum)).toBe('0.3000');
    expect(toCents(sum)).toBe(30n);
    expect(centsToDecimal(30n).toFixed(2)).toBe('0.30');
  });

  it('formata valores BRL em PT-BR corretamente', () => {
    expect(formatBrl('1500.5')).toBe('R$ 1.500,50');
    expect(formatBrl('-1200.00')).toBe('-R$ 1.200,00');
  });

  it('gera hash SHA-256 determinístico idempotente para deduplicação (SPEC-08)', () => {
    const params = {
      userId: '11111111-1111-4111-8111-111111111111',
      ticker: 'wdox26',
      executedAt: new Date('2026-10-09T13:05:42.999Z'),
      side: 'buy',
      qty: '2',
      price: '5450.50',
    };

    const h1 = computeTradeDedupHash(params);
    const h2 = computeTradeDedupHash({
      ...params,
      ticker: ' WDOX26 ',
      side: 'BUY',
      // Mesmo minuto UTC, segundos diferentes -> mesmo hash (executed_at_minute)
      executedAt: new Date('2026-10-09T13:05:01.000Z'),
    });

    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);

    // Garante paridade bit-a-bit da implementação isomórfica SHA-256 com node:crypto
    const sample = 'tradepilot-ai|WDOX26|2026-10-09T13:05Z|BUY|2.0000|545050';
    expect(sha256Hex(sample)).toBe(
      createHash('sha256').update(sample, 'utf8').digest('hex'),
    );
  });
});
