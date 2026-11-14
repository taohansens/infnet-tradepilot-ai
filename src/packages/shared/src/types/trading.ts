/**
 * Tipos de domínio operacional, ingestão e segregação tributária do TradePilot AI.
 *
 * @spec SPEC-06
 * @spec SPEC-07
 * @spec SPEC-08
 * @spec SPEC-09
 * @spec SPEC-10
 * @spec SPEC-23
 * @rf RF-M1-1
 * @rf RF-M1-5
 * @rf RF-M1-6
 * @rf RF-M1-7
 * @rf RF-M5-1
 */

export const MARKET_TYPES = ['WIN', 'WDO', 'ACOES', 'OPCOES'] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

export const TRADE_SIDES = ['LONG', 'SHORT'] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

export const ORDER_SIDES = ['BUY', 'SELL'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

/**
 * Silos tributários estritamente segregados na apuração B3.
 * Prejuízo de DAY_TRADE nunca compensa lucro de SWING_TRADE e vice-versa.
 *
 * @spec SPEC-23
 * @spec SPEC-25
 * @rf RF-M5-1
 * @rf RF-M5-2
 * @rnf RNF-20
 */
export const TAX_SILOS = ['DAY_TRADE', 'SWING_TRADE'] as const;
export type TaxSilo = (typeof TAX_SILOS)[number];

export const INGESTION_SOURCES = ['B3_CSV', 'PROFIT_CSV', 'SINACOR_PDF', 'MANUAL', 'DEMO'] as const;
export type IngestionSource = (typeof INGESTION_SOURCES)[number];

export const INGESTION_JOB_STATUSES = [
  'QUEUED',
  'PROCESSING',
  'AWAITING_REVIEW',
  'COMMITTED',
  'FAILED',
] as const;
export type IngestionJobStatus = (typeof INGESTION_JOB_STATUSES)[number];

export const DEDUP_STATUSES = ['NEW', 'EXACT_DUPLICATE', 'CONFLICT'] as const;
export type DedupStatus = (typeof DEDUP_STATUSES)[number];

export const CONCILIATION_ACTIONS = ['IGNORE', 'OVERWRITE', 'MERGE_COSTS'] as const;
export type ConciliationAction = (typeof CONCILIATION_ACTIONS)[number];

/**
 * Configuração de contrato/instrumento B3 por usuário (valor do ponto, tick,
 * custo por contrato, custo por ordem e ISS) — inspirado no Taometria.
 * Todos os campos numéricos trafegam como string decimal exata (`NUMERIC(18,4)`).
 *
 * @spec SPEC-06
 * @spec SPEC-10
 * @rnf RNF-11
 * @rnf RNF-20
 */
export interface InstrumentConfigDto {
  id?: string;
  asset_type: 'futuros' | 'acoes' | 'opcoes';
  contract_prefix: string;
  tick_size: string;
  point_value: string;
  cost_per_contract: string;
  cost_per_order: string;
  iss_percent: string;
  is_active: boolean;
}
