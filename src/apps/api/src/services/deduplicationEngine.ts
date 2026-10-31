import {
  computeTradeDedupHash,
  toDecimal,
  type ConciliationAction,
  type DedupStatus,
} from '@tradepilot/shared';
import type { ParsedStagingRow } from './ingestionParser.js';

/**
 * Motor de Deduplicação Idempotente por Hash SHA-256 (`SPEC-08`).
 *
 * Calcula `hash(user_id, ticker, executed_at_minute, side, qty, price_cents)`
 * e classifica cada item de staging contra operações já persistidas do mesmo
 * titular em:
 * - `NEW`: sem correspondência anterior
 * - `EXACT_DUPLICATE`: mesmo hash e mesmos custos (`fees` e `irrf`)
 * - `CONFLICT`: mesmo negócio base com divergência em `fees` e/ou `irrf`
 *
 * @spec SPEC-08
 * @rf RF-M1-7
 * @rnf RNF-9
 * @rnf RNF-11
 * @rnf RNF-20
 */

export interface ExistingTradeForDedup {
  id: string;
  dedupHash: string;
  fees: string;
  irrf: string;
}

export interface ClassifiedStagingRow extends ParsedStagingRow {
  dedupHash: string;
  dedupStatus: DedupStatus;
  matchedTradeId: string | null;
  diffFields: string[];
  recommendedAction: ConciliationAction | null;
}

function decimalsEqual4(a: string, b: string): boolean {
  return toDecimal(a)
    .toDecimalPlaces(4)
    .equals(toDecimal(b).toDecimalPlaces(4));
}

/**
 * Classifica um lote de linhas parseadas em `NEW`, `EXACT_DUPLICATE` ou `CONFLICT`.
 *
 * @spec SPEC-08
 * @rf RF-M1-7
 * @rnf RNF-9
 * @rnf RNF-20
 */
export function classifyStagingRows(params: {
  userId: string;
  rows: ParsedStagingRow[];
  existingTrades: ExistingTradeForDedup[];
}): ClassifiedStagingRow[] {
  const existingByHash = new Map<string, ExistingTradeForDedup>();
  for (const trade of params.existingTrades) {
    if (trade.dedupHash) {
      existingByHash.set(trade.dedupHash, trade);
    }
  }

  // Rastreia hashes já vistos dentro do próprio arquivo para idempotência intralote
  const seenInBatch = new Map<string, ParsedStagingRow>();

  return params.rows.map((row) => {
    const dedupHash = computeTradeDedupHash({
      userId: params.userId,
      ticker: row.ticker,
      executedAt: row.executedAt,
      side: row.side,
      qty: row.qty,
      price: row.price,
    });

    const existing = existingByHash.get(dedupHash);
    if (existing) {
      const diffFields: string[] = [];
      if (!decimalsEqual4(row.fees, existing.fees)) {
        diffFields.push('fees');
      }
      if (!decimalsEqual4(row.irrf, existing.irrf)) {
        diffFields.push('irrf');
      }

      if (diffFields.length === 0) {
        return {
          ...row,
          dedupHash,
          dedupStatus: 'EXACT_DUPLICATE',
          matchedTradeId: existing.id,
          diffFields: [],
          recommendedAction: 'IGNORE',
        };
      }

      return {
        ...row,
        dedupHash,
        dedupStatus: 'CONFLICT',
        matchedTradeId: existing.id,
        diffFields,
        recommendedAction: 'MERGE_COSTS',
      };
    }

    const duplicateInBatch = seenInBatch.get(dedupHash);
    if (duplicateInBatch) {
      const diffFields: string[] = [];
      if (!decimalsEqual4(row.fees, duplicateInBatch.fees)) {
        diffFields.push('fees');
      }
      if (!decimalsEqual4(row.irrf, duplicateInBatch.irrf)) {
        diffFields.push('irrf');
      }

      return {
        ...row,
        dedupHash,
        dedupStatus: diffFields.length === 0 ? 'EXACT_DUPLICATE' : 'CONFLICT',
        matchedTradeId: null,
        diffFields,
        recommendedAction: 'IGNORE',
      };
    }

    seenInBatch.set(dedupHash, row);

    return {
      ...row,
      dedupHash,
      dedupStatus: 'NEW',
      matchedTradeId: null,
      diffFields: [],
      recommendedAction: null,
    };
  });
}
